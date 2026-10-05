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

## D-011 — `l3_jti` is derived from the signed L3a bytes, so it is a replay id, not a request id

**Date:** 2026-10-04 · **Raised by:** WP-03 · **Spec item:** §7.2 `checkout_attempts.l3_jti` UNIQUE
**Decision:** `jti` = base64url SHA-256 of the L3a issuer JWT. Nothing else, and specifically **not**
derived from the L2, the amount, the clock or a per-attempt nonce.
**Reason:** The L3 payload the library produces has **no `jti` claim**, but §7.2 requires a unique
`l3_jti` and §8.10 check 7 uses it as the replay defence (EC-IDEM-1, EC-MER-2). Deriving it from the
signed token makes it a pure function of the exact bytes the Gate is being asked to authorise, which
is the one property that defence needs: submitting the *same signed L3* twice yields the same `jti`,
the UNIQUE index `checkout_attempts_l3_jti_key` refuses the second insert, and that refusal maps to
`GATE_REPLAY`. It is also content-bound, so two different authorisations cannot collide on it.

**Correction (2026-10-05, QA2-VI-2).** This entry previously claimed the `jti` was *deterministic
across retries of the `l3/create` request* — "a retried request produces the same id, so an idempotent
retry cannot consume its own replay protection", and `l3.py`'s module docstring made the same claim.
**Both halves were false and the stated rationale was inverted.** `create_l3` takes `iat`/`exp` from
`now_sec()`, so a retry across a second boundary changes the payload; and `create_disclosure` mints a
fresh `os.urandom(16)` salt per disclosure, so even inside a single second a retry produces different
disclosure bytes, a different `delegate_payload`, a different issuer JWT and a different `jti`. Two
`l3/create` calls in the same second yield two different `jti`s. The UNIQUE index therefore cannot
fire on a retried *request*, so the retry "consumes fresh replay protection" rather than being
absorbed by it — the opposite of what was documented.

**Semantics chosen.** A retried `l3/create` is a genuinely **new authorisation** — different `iat`,
different disclosure salts, different signature — so it gets a new `jti`, and that is correct.
Reusing one would make the UNIQUE index refuse a legitimate retry. So: `jti` identifies *the signed
L3a*, not the request, and **what absorbs a retry is not the `jti`**. Per §8.6 every side-effecting
PayPal call carries a deterministic `PayPal-Request-Id` derived from our own IDs, and that is the
retry-idempotency defence; the `jti` covers the other direction, the same signed token captured and
replayed later. Both are required. They are different defences and this entry previously conflated
them.
**Evidence:** `apps/vi/src/vi_service/l3.py` (module docstring and `create_l3`),
`apps/vi/src/vi_service/models.py` (`L3CreateResponse.jti`),
`apps/vi/tests/test_l3.py::test_EC_IDEM_1_jti_identifies_the_signed_token_not_the_request`.

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


## D-022 — §8.15's router table has three gaps, and §8.16 requires answers it does not contain

**Date:** 2026-10-05 · **Raised by:** WP-15a · **Spec item:** §8.15, §8.16
**Decision:** Implement the spec's rules verbatim as far as they go, and add named ids for the three
postures it does not define. Documented below rather than smuggled in as exceptions.

1. **No appeal rule.** §8.15's table has no `APPEAL` posture, yet §7.3 lists `APPEAL` in
   `dispute_actions`, §8.9 lists `appeal` among the dispute calls, and §12.9's EC-DSP-3 says the
   strategist proposes an appeal when a new fact arrives. Added `R-APPEAL-1`: lost the case, the
   `appeal` HATEOAS link is present, and something material arrived since the decision.
   **Why the link rather than `dispute_state === 'APPEALABLE'`:** PayPal states twice, in the API
   reference and in the disputes guide, that the link is what determines eligibility ("If this link
   does not appear, you cannot appeal the dispute"). This is the same correction as D-014, reached from
   the other end.
2. **No `MESSAGE_ONLY` posture.** The spec's enum is a filing posture set. But `R-DLNG`'s whole point
   is that a parcel still in transit should be *waited on*, not filed against — spending one of a
   merchant's response attempts on a parcel that has not landed is the expensive choice. Added
   `R-INR-3` (tracker registered, still moving) → `MESSAGE_ONLY`.
3. **No weak-UNAUTHORISED row.** EC-BUY-3 covers an `UNAUTHORISED` claim without a passkey, which the
   spec's `R-UNAUTH-1` assumes exists. Added `R-UNAUTH-3` → `REVIEW`, because "absorb it or fight a
   case with no passkey" is a money decision with no honest default.

Two ordering fixes were also needed, and both are the kind of thing that makes a rule table look
complete while being unreachable:

- **`R-UNAUTH-2` could never fire.** `R-UNAUTH-1`'s stated condition is *also* true when the device
  was stolen and the attacker used the passkey, so first-match ordering meant the "device was already
  lost before the mandate was signed" branch was dead code. `R-UNAUTH-2` now precedes it.
- **`R-CNP-1` could never fire** for a full refund, because `R-REF-1` (`ALREADY_REFUNDED`) matches
  first and the spec's ordering is first-match-wins. It now requires a *partial* refund, which is the
  case it was written for.

Also split `R-NOCHAIN-1` into `R-NOCHAIN-1` and `R-CHAIN-BAD`: the spec's single row would tell a
merchant "No mandate on this payment" when a mandate exists and merely failed to verify. Those are
different conversations, and conflating them would be the first thing a merchant asks about.

**Result: 22 rules — 14 verbatim from §8.15, 8 documented extensions.** The 40-case eval scores
**40/40 exact (100.0%) on `ruleId` + `posture`, 40/40 on evidence types** (§8.16 AT-M15.1).

## D-023 — The Defender's LLM ban is scoped to the files that choose the posture, not the package

**Date:** 2026-10-05 · **Spec item:** §8.15, §8.16, §18 q20
**Decision:** `eslint.config.mjs` bans `ai`, `@ai-sdk/*`, `openai`, `@anthropic-ai/*` and `ollama`
in `packages/defender/src/{rules,router,rationale,types}.ts` — and **not** elsewhere in the package.

**Reason:** Judge question 20 asks *"what stops the AI from filing a bogus dispute against a good
customer?"* The answer has to be structural, and there are two ways to make it structural, only one of
which is honest:

- **Ban the whole package.** Then WP-15c's drafter cannot call a model to write the notes, which it
  legitimately must. The ban would be unsatisfiable, so it would get deleted — or, worse, it would
  drive the drafting into a package with no rule over it. That is strictly worse than not banning.
- **Ban the files that decide the posture.** `rules.ts`, `router.ts` and `rationale.ts` stay pure;
  `planner.ts` and the drafter may use a model. This is the boundary the design actually needs, and it
  is exactly the boundary §8.15 vs §8.16 draws: the rules table picks `CONTEST` or `REFUND`, and the
  model writes the prose.

**Why a file-scoped rule and not just the existing structural test:** `test/router.test.ts` asserts the
same boundary by reading the source, which catches it in CI — but only after the commit. A lint rule
fails in the editor while the line is being written. Both exist, deliberately: removing the lint rule
does not silently open the hole, and removing the test does not either.

**Verified to fire,** not assumed: a planted `import { generateText } from 'ai'` in `router.ts` fails
with the rule's message, and the same plant in `packages/gate/src/evaluate.ts` still fails with the
Gate's message. Both files restored byte-for-byte afterwards.

## D-024 — "Was this device lost before the mandate was signed?" comes from the audit log, not a column

**Date:** 2026-10-05 · **Raised by:** WP-15a · **Spec item:** §7.2, §12.9 EC-KEY-1
**Decision:** `R-UNAUTH-2` derives the device-lost instant by querying the hash-chained `audit_log`, and
migration `0001_audit_log_subject_action_at` replaces `audit_log_subject_idx` with
`audit_log_subject_action_at_idx`. **No `devices.lost_at` column is added.**

**Reason:** WP-15a reported the schema as missing a column, which is a reasonable reading — `devices`
carries `status` but no timestamp for when it became `LOST`. The audit log already answers it, and the
difference matters because of who the fact is for.

This ordering decides a live money question: on an `UNAUTHORISED` dispute it is the difference between
"a key on a lost device still verifies, so we cannot show the person who signed was the account holder"
(**accept the claim, pay `$89`) and "a valid chain and a passkey is an authorised purchase" (**contest
it, save the `$89`). `R-UNAUTH-2`'s rationale says so out loud, because a merchant reading a
contest-packet that turned out to be unprovable will remember that rather than the reasoning.

An `audit_log` row is hash-chained to its predecessor, so rewriting one breaks the chain and the
tamper is detectable. A `lost_at` column can be updated without trace — which means the one fact the
Defender relies on to *lose* a contest could be quietly edited into a fact that makes it win. §12.13
keeps operational data 365 days against a ~120-day dispute window, so the row is always there when the
question is asked.

**Index, not a second index:** the existing `(subject)` index already serves the privacy export and the
dispute timeline, and Postgres uses a btree's leftmost prefix — so `(subject, action, at)` serves all
three with one index instead of two.
**Evidence:** `packages/db/src/schema.ts` `audit_log`;
`packages/db/drizzle/0001_audit_log_subject_action_at.sql` (renamed from drizzle's `0001_tired_chimera`,
which said nothing about what the file does).


## D-025 — The evidence PDF uses `pdf-lib`, not D15’s `@react-pdf/renderer`, and lives in `packages/defender`

**Date:** 2026-10-05 · **Raised by:** WP-15d · **Spec item:** D15, §4 tech table, §5 tree, §8.18
**Decision:** Render the packet with `pdf-lib` + `@pdf-lib/fontkit` from `packages/defender/src/evidence-doc.ts`,
not `@react-pdf/renderer` from `packages/evidence-pdf/`.

**Reason — three, in order of how much they matter.**

1. **§8.18 requires the same packet to render byte-identically.** That is only achievable with a
   low-level API where every varying value can be pinned. `pdf-lib` writes a content stream we build;
   `@react-pdf/renderer` is a React renderer whose output we do not control, and a layout engine is
   exactly the sort of thing that changes a page count or a line break between versions. The
   determinism requirement is a **spec requirement**, so it outranks the library choice — but that is a
   judgement call, and a reader is entitled to see it made explicitly rather than discovered later.
2. **The dependency graph.** `@react-pdf/renderer` pulls React and its reconciler into a
   **server-side** package that renders one document per dispute. `pdf-lib` is a font-and-graphics
   library with no UI framework in it.
3. **Location.** §5’s tree puts this in `packages/evidence-pdf/`, which still exists as a stub. The
   renderer lives beside the planner, the drafter and the citation checker because all five share
   `ClaimSource`, `ClaimArtefactKind` and `publicPacketUrl` — and §8.18’s packet is a **view of the
   Defender’s decision**, not an independent document. Splitting it would mean the packet and the note
   it renders could disagree about what a claim is.

**Cost, stated honestly:** a judge comparing the stack against spec §4 will see `pdf-lib` where
`@react-pdf/renderer@4.9.0` is pinned, and this entry is the answer. `packages/evidence-pdf/` is left
in the tree rather than deleted, so the spec’s layout is still visibly acknowledged rather than erased.

**Evidence:** `packages/defender/src/evidence-doc.ts`; `packages/defender/README-DRAFTER.md`.
Byte-identity is asserted in `test/evidence-doc.test.ts`, and the font is Roboto (Apache-2.0) committed
with its licence under `packages/defender/assets/` — no font is fetched at build time and no system
font is assumed present on Render.

## D-026 — The QR is decoded by an independent decoder, and one false test was rewritten rather than dropped

**Date:** 2026-10-05 · **Spec item:** §8.18 “Live re-verification”
**Decision:** Add `jsqr` as a **devDependency only**, and decode the rendered matrix in tests. One
assertion was found false and rewritten.

**Reason:** the QR is the only part of the packet a reader is meant to **act on** — scanning it opens
`/v/{packetId}` and re-runs the chain verification. A test comparing our matrix against `qrcode`’s
encoding of the same string is a **round-trip identity check**: both sides are the same encoder, so it
proves we encode the string we mean to and says nothing about whether the symbol is scannable.
`test/qr.test.ts` was honest about that limit, which is exactly why it went unnoticed. An independent
decoder, in the opposite direction, over a raster built the way the renderer builds it, is the
assertion that can fail.

**The false assertion, kept as a record.** A test asserted that a symbol drawn with **no quiet zone**
fails to decode. It does not: `jsQR` locates the finder patterns by scanning the whole raster and does
not enforce ISO/IEC 18004 §9.1’s 4-module margin, whereas a phone camera does. Asserting `null` would
have asserted a property of the decoder we happened to pick rather than a property of the packet — and
it would have passed or failed for reasons unrelated to what we ship. The test now records both
behaviours and says which one is ours.

**What is asserted instead:** the symbol decodes to `PUBLIC_BASE_URL + /v/{packetId}` under an
independent decoder; a one-character change decodes to the changed string, so the assertion is
discriminating rather than vacuous; an **inverted** symbol decodes to nothing, which is what makes the
positive case trustworthy; and the symbol survives every scale the renderer might use (2/3/4/6/8 px per
module), because a code that scans only on a developer laptop is worse than no code at all.

**Evidence:** `packages/defender/test/qr-decode.test.ts`. `jsqr` is dev-only and ships in nothing.

## D-027 — The root test run timed out because of unbounded worker parallelism, not slow tests

**Date:** 2026-10-05 · **Raised by:** WP-15e observing 7 failures in the root run that passed per-package
**Decision:** The run-wide vitest flags (`--testTimeout=20000 --hookTimeout=30000 --maxWorkers=6`) live
in `package.json`'s `test` script, and CI calls `pnpm test:ci` rather than `pnpm vitest`.

**Reason — the honest sequence, because the first fix was wrong.**

1. `pnpm test` (root, 70 files) reported `Test timed out in 5000ms` in nine files. `pnpm --filter <pkg>
   test` passed the same tests. So the tests were fine and the two runs disagreed.
2. **First attempt:** put `testTimeout` and `maxWorkers` in `vitest.workspace.ts`. That changed *which*
   tests failed and they still said 5000 ms — so it did nothing. A Vitest workspace root
   `test` block supplies project **discovery**; per-project options come from each project config, and
   the root run-wide knobs are not applied to them.
3. **What the real cause looked like,** once the timeouts were out of the way:
   `[vitest-pool]: Failed to start forks worker for test files …`. On 24 cores vitest defaults to ~23
   fork workers for 70 files. Each is a separate Node process, and several suites are CPU-bound *and*
   memory-heavy — 2,000 Ed25519 verifications, PDF rendering with font subsetting, a 515 KB TTF in the
   graph, QR rasterising. Twenty-three of those thrash, and every test that was genuinely working
   slowly is reported as a timeout.
4. So the cause is **unbounded parallelism**. A timeout increase only moved the symptom, and it is
   worth naming that as a mistake: the four "fixes" before this one (per-test `{timeout}` overrides on
   the fuzz suite, the race property test, the 20k-ULID test) were each treating a configuration defect
   as a test defect.

**CI-relevant, not a local quirk.** GitHub standard runners are 2-core. The unsharded default would
have failed there identically, and CI was calling `pnpm vitest --run --shard=N/3`, which bypasses the
npm script and therefore the flags — so the bug was on the path to a green build as well.

**Fixed worker count, not a derived one.** A machine-dependent `maxWorkers` makes the suite behave
differently on a laptop and on a runner, so a timeout that passes locally can still fail in CI. A
reproducible run is worth more than the four minutes saved.

**Side finding worth keeping:** `drizzle-kit` 0.31.11 **swallows migration errors and exits 1 with no
diagnostic at all** — 272 characters of output, no error line. It is reached whenever the database has
tables but no drizzle journal, which is a real state (a partially-applied deploy, a restored dump).
`pnpm db:migrate` failing in CI or in Render 's `preDeployCommand` would therefore be a red build
with no stated reason. Exit codes are still correct, so the gate holds; the diagnosis is what is
missing.

## D-028 — Two schema gaps the Defender found by reading §7.2 against real behaviour

**Date:** 2026-10-05 · **Raised by:** WP-15e · **Spec item:** §7.2 `refunds`, `dispute_actions`
**Decision:** Migration `0002_refunds_completed_at_and_refund_action` adds `refunds.completed_at` and
adds `REFUND` to the `dispute_action` enum. Both are additions; no data is rewritten and no column is
dropped, so it is safe to apply to a database that already holds disputes.

**1. `refunds.completed_at`.** `R-REF-1` asks "have we already refunded this?", which is a question
about **settled** money. PayPal settles a refund days after we create it, so reading `created_at`
answers "yes" for a refund that later failed and for one still in flight. The error is expensive in
both directions: contesting an already-refunded capture wastes one of the merchant's response
attempts, and accepting a claim already paid costs the money twice. Spec §7.2 lists no such column.

**2. `dispute_action` gains `REFUND`.** Spec §7.2 lists eight values, none of them a refund, so a
`REFUND`-posture dispute was being recorded as `ACCEPT`. That is not a naming preference: `ACCEPT`
means *we conceded the buyer's claim to PayPal*, and a refund issued in settlement is a different
act with different consequences. `R-OTHER-REFUND` alone refunds by default, which makes this the most
common outcome in the product and the least accurate field in it — anything reading
`dispute_actions.action` alone, which is the S-17 timeline, an audit, and any judge asking whether we
contested, would have been reading a lie about our own behaviour.

**Verified against a real Postgres 17:** migrations apply, a second `migrate` is a no-op (AT-M2.1), the
seed is idempotent twice over (AT-M2.2), the enum lists all nine values including `REFUND`, and the
column is `timestamp with time zone`.

**A reported crash that was not one.** WP-15e also flagged `packages/webhooks/src/jobs.ts` casting
`dispute_life_cycle_stage` unchecked, which would fail as Postgres `22P02` inside the store call.
Probed rather than fixed: `rankDispute({stage: 'BRAND_NEW_STAGE'}).known === false`, and the
`!next.known` guard returns before the write, so no unrecognised stage can reach the database. Not a
live bug. It was still changed to `disputeStageOf(next)` — the accessor written for exactly this call,
which returns `null` rather than a guess — because the cast was correct only by accident of ordering,
and both safety properties now live in one place instead of one place plus a reader's memory
about the line above. Verified identical for every recognised stage.

## D-029 — The verifier and the PDF were each carrying their own copy of the packet URL

**Date:** 2026-10-05 · **Raised by:** WP-18 · **Spec item:** §8.18, §8.15 "one URL per document"
**Decision:** `publicPacketUrl` is exported from `@countersign/defender` and re-exported by
`@countersign/verifier`. No second implementation exists.

**Reason.** `qr.ts` encodes this address into the evidence PDF, `citation-check.ts` refuses any note
containing a *different* one, and `/v/[packetId]` is what a scan opens. Those three are the same string
by construction or they are a bug waiting to be found. WP-18 could not import it — the symbol was not
re-exported from `defender`’s index and that package’s `exports` map allows only `"."` — so it kept a
one-line mirror plus a cross-base-URL agreement test that imported the original by **relative path**.
A reasonable mitigation and still a second implementation; AGENTS.md rule 8 is why it was not simply
fixed in place.

**The failure mode is specific and quiet.** Divergence produces a perfect-looking evidence packet whose
QR opens a 404. §8.18 says the QR is what makes "you do not have to trust us" something the reader can
act on, so that symptom lands on the one reader the product exists to reassure — a PayPal adjudicator,
with a printed copy, in front of a judge.

## D-030 — `evidence_packets.bundle_hash` is constrained to base64url, because hex would fail silently

**Date:** 2026-10-05 · **Raised by:** WP-18 · **Spec item:** §7.3, D18
**Decision:** `CHECK (bundle_hash ~ '^[A-Za-z0-9_-]{43}$')` plus an index on the column.

**Reason.** WP-18 reported that `apps/vi` returns `bundle_hash` as base64url while the column was
unconstrained text, and reported a hex/base64url split. The split is real but the column’s own comment
says it "equals the `custom_id` payload" — and `custom_id` is base64url — so the intent was already
stated and simply not enforced.

**Why a CHECK and not a comment.** A SHA-256 digest is 32 bytes, so base64url of it is always 43
characters with no padding. Without the constraint a hex digest stores happily and then fails every
comparison, and `disputes.ts` looks packets up by this column — so the symptom would be **"no packet with
that id"** for a packet that exists. A wrong answer to "is this genuine?" has to be loud, and a lookup
failure is the quietest possible way to be wrong.

**The index, not just the constraint.** `disputes.ts` finds a packet by hash when a reviewer re-verifies,
so without it that path seq-scans the table once per dispute.

**Still open, and deliberately not worked around:** `packages/db` has no repository for
`evidence_packets` or `jwks_keys`. WP-18’s routes read both through the same `repo()` wrapper and the
port names what should satisfy it. That is a missing abstraction rather than a defect, and it belongs
with the rest of `packages/db`’s repos rather than being invented twice.

## D-031 — Env strictness moved onto near-misses, and the model key became optional

**Date:** 2026-10-05 · **Raised by:** senior QA audit 1 (QA-env-1, QA-web-1) · **Spec item:** §6
**Decision:** `envSchema` is no longer `.strict()`. Unrecognised keys are ignored **unless** they
are within two Damerau-Levenshtein edits of a key we do read, in which case boot is refused with
the intended name attached. `OPENAI_API_KEY` is optional. `apps/web` `start` is `next start`.

**1. Why strictness was not simply removed.** `.strict()` conflated two failures that deserve
opposite answers:

| Situation | Correct | `.strict()` |
|---|---|---|
| `DATABSE_URL` — a typo in one of ours | **refuse to boot.** The variable meant to hold the database password holds nothing | refused |
| `GIT_BRANCH`, `USERNAME`, `npm_config_*` — the developer shell | **ignore it** | refused |

The second row is the reported bug: adding one unrelated variable produced
`Invalid environment: : Unrecognized key: "GIT_BRANCH"`, the worker refused with exit 78, and the
message enumerated eighty of the developer own unrelated variables while hiding the real cause.
So strictness is **moved**, not dropped — a typo of ours is still a hard error, now with
`did you mean DATABASE_URL?` attached. Both halves are pinned by tests, because the second half is
worthless without the first.

**Why the edit distance is bounded at two.** An unbounded "is this close to one of ours" check
finds matches everywhere in a shell holding hundreds of variables. Unbounded similarity would be
**worse** than none, because it produces a hard error about the wrong variable. Case is compared
case-insensitively for the same reason: Windows populates `Path` and `USERPROFILE`, and failing boot
over that is absurd.

**2. `OPENAI_API_KEY` was required and nothing read it.** No file in the repository reads it — the
drafter and the agent take a model by dependency injection. The cost was that `parseEnv` refused
every process without one, so the project could not boot for anyone without an OpenAI key, and
therefore the Gate, the router, the compiler read-back, the order path and the public verifier
could not be demonstrated by anyone who lacked one. That is a large part of the product gated
behind the one dependency it is explicitly designed to work without (D-018, D-023, WP-15e optional
`FileDeps.llm`). It is now optional and `/status` reports its absence as "not configured".

**3. `apps/web` `start` was `next start -p ${PORT:-3000}`.** POSIX parameter expansion, which pnpm
does not perform on Windows, so the command a judge or the README tells them to run failed
outright: `option -p, --port <port> argument ${PORT:-3000} is invalid`. Next reads `PORT` itself,
so the expansion was never necessary.

**Four bugs found in the fix while making it**, all of which the tests caught:

- `Object.freeze(Object.keys(...)).sort()` — `Array.prototype.sort` writes into the receiver, and
  the receiver is frozen. Sorted before freezing.
- The near-miss loop needed `noUncheckedIndexedAccess` handling, and the honest form is an
  accessor that **throws** on a short row rather than a `?? 0` default, which would be a lie
  dressed as a fallback.
- `CsError` is a plain object with a `message` field, **not** an `Error` subclass, so a test
  extracting `e instanceof Error ? e.message : String(e)` was asserting on `[object Object]` and
  passing without checking anything.
- The test fixture was hand-written and wrong (`APP_ENV` domain, `VI_KEK` base64 shape). The
  required set is now **derived** in the test, so a new required variable fails one readable test
  instead of nine with "Unrecognized key".

## D-032 — The signed-budget reader is verified against a real vi capture, and `max` above 2^53 is refused too late

**Date:** 2026-10-06 · **Raised by:** verification of the QA-gate-1 fix · **Spec item:** §7.2, D19, D18
**Decision:** Commit `packages/gate/test/fixtures/vi-verify-budget-capture.json` as the authority for
the disclosed-constraint shape, and add `max <= 2^53-1` enforcement at the route (reported below, not
yet applied — it belongs to `apps/vi`).

**The earlier fix was read from `apps/vi` source, not from a running service, and that uncertainty is
now closed.** The Gate reads the signed budget from `disclosed.l2.delegate_payload[*].constraints[*]`.
Captured from a real `POST /v1/verify` against `apps/vi`’s own routes through `testclient`, with every
token signed by the pinned library at `356c296…`:

```
verify_response.disclosed.l2.delegate_payload[1].constraints[2]
{"currency":"USD","max":13000,"type":"mandate.payment.budget"}
```

Keys are exactly `currency`, `max`, `type`, and **`min` is absent rather than null** — which matters,
because `to_dict()` omits optional fields and a `.nullable().default(null)` schema that expected an
explicit null would have failed on every real budget constraint. `readSignedBudget` returns
`found: true` with `max: 13000n`, and `evaluate` ALLOWs a $30.00 cart under a signed $130.00 ceiling
while BLOCKing a $140.00 cart with `GATE_BUDGET_EXCEEDED`.

**The hash-indirection worry is settled, and negatively.** It was suspected that a constraint might be
reachable only through `resolve_disclosure_refs`’ hash indirection, which the structural walker does
not follow. Three independent lines of evidence say it cannot happen: `create_layer2_autonomous`
creates refs only via `_match_merchant_refs`/`_match_item_refs`, which wrap **merchants and items**,
never a constraint object; `resolve_disclosure_refs` only resolves and is never applied to
disclosed.l2 at all; and in the capture **0 of 8** constraint entries is a bare ref — refs appear only
nested inside `allowed` and `acceptable_items`. Were it to happen, `readSignedBudget` returns
`found: false` and the obligation gate BLOCKs.

**The real hole: `max` above `2^53-1`.** 83 library `to_dict()` outputs were generated at runtime and
checked against `budgetConstraintSchema`. 79 pass. Of the 4 failures, 2 are `extra_fields`, which
cannot reach a signed L2 at all because vi’s `_ConstraintBase` is `extra="forbid"` — an extra key is
a 422 at `l2/prepare`. The remaining 2 are genuine:

`apps/vi` accepts and **signs** `max: 9007199254740993`, which is `2^53 + 1`. JavaScript `JSON.parse`
has already corrupted that to `…992` by the time zod sees it, so `readSignedBudget` reports
`found: false` and the Gate BLOCKs. Fail-closed, and the value is unrecoverable either way — but the
service should refuse it at the route rather than sign a constraint no verifier can read.
**Fix belongs in `apps/vi/src/vi_service/models.py` on `BudgetConstraint.max`** (add `le`), or in
`vi-client`’s `budgetConstraintSchema`. Not applied here: `apps/vi` was mid-edit by another agent.

**Also confirmed while checking this:** `recurrence` and `agent_recurrence` differ on exactly the
occurrence key — `number` versus `max_occurrences` — and the Gate reads both correctly. That
distinction is load-bearing rather than cosmetic: reading the wrong one leaves
`max_occurrences: null`, which `evaluateRecurrence` treats as "the date window is the entire limit",
which is the loosest possible reading of a signed cap. There is now a test that would fail if the
reader regressed to the wrong key.

## D-033 — SD-JWT completeness is enforced at the verifier, because disclosures are not signed

**Date:** 2026-10-06 · **Raised by:** senior QA audit 2 (QA2-VI-1, `critical`) · **Spec item:** §8.3,
§8.0 rule 4, §3.1 · **Verified:** re-running the auditor own probe reports `BYPASSES CONFIRMED: 0`

**Decision:** `apps/vi` refuses any L1/L2/L3a/L3b presentation that omits a disclosure the **signed**
payload commits to by hash. `resolve_disclosure_refs` no longer falls back to returning the
unresolved reference. `checked` carries bare registered types only, so `checked.includes(name)`
means *evaluated*.

**The defect.** SD-JWT disclosures live after the `~` and are therefore **outside the JWS signature**,
which covers `header.payload` only. The signed payload commits to `hash(merchant)`, but nothing
required every committed hash to be *present*, and SD-JWT gives no completeness guarantee. The party
presenting the token is the agent — untrusted per §3.1 — so it chose what travelled.

Three layers each failed open, and all three had to be closed:

1. `l2.py:283` was `return by_hash.get(entry["..."], entry)` — a missing disclosure left the
   **unresolved reference itself** in the constraint.
2. The library `_check_allowed_payee` treats "every entry is an SD ref" as **skip-and-pass**, appending
   `… (skipped: no resolved payees)` with `satisfied` still `True`.
3. `find_disclosures` picked the merchant **by position** while `resolve_disclosure_refs` picked **by
   hash** — different selections, so the sanity check passed while enforcement was blind.

Result: `chain_valid: true`, `violations: []`, for a payment to a merchant the buyer never authorised,
reproduced on the **unauthenticated** `/v1/public/verify`. Why this outranks the budget bug: a missed
cap spends slightly too much, and this decides **who gets paid**.

**Why a completeness gate and not filtering.** Narrowing the input would make the bypass return
`chain_valid: true` with fewer constraints reported — which looks like a fix and is worse than none,
because the verifier would be reporting a chain it did not evaluate.

**The subtle part: a digest-disclosed claim and a withheld one are not distinguishable, and the
reason is structural rather than incidental.** SD-JWT `_sd` encodes both "the value travels as a
disclosure" and "the value is disclosed by digest with the value left inline", and a disclosure hash
covers a fresh `os.urandom(16)` salt, so it cannot be inverted or even matched against a candidate.
No algorithm reads `_sd` and partitions it. So this had to be a policy choice, and only one of the two
available policies is sound:

- *Require every `_sd` entry to be presented* — **unsound**. It would refuse the L1 own `email`, which
  the issuer never intended as a disclosure, breaking every working chain.
- *Require every placeholder to be present* — **decidable**. `{"...": h}` **is** the encoding of "the
  value is not in this token, it is in the disclosure with this hash". A placeholder in the signed
  bytes with no matching disclosure is not a policy judgement; it is a commitment the signature made
  and the presenter withheld. **This is what is implemented.**

The unsound alternative was rejected on evidence, not taste: every disclosure carrying authority or a
constraint in this library is reachable from a placeholder. The one exception is the L1 `email`, which
carries no constraint and no money, and which `verify_chain` already covers because the L2 `sd_hash`
pins the exact L1 presentation.

**Two fail-opens remain in the pinned library** (`constraint_checker.py:196-202` and `243-252`, where
"every entry is an SD ref" is an error condition treated as a pass). They are the *reason* this gate
exists rather than something to fix at source. Fixing them upstream is a pin change, which is a
decision for the maintainers of this repository and not one to slip into a fix.

## D-034 — The Gate reads a `jti` claim the pinned library never writes, so check 7 never passes

**Date:** 2026-10-06 · **Raised by:** the D-033 fix, then confirmed here · **Spec item:** §8.10 check 7,
EC-IDEM-1, §7.2
**Status:** open. Recorded now because it is the **fourth** instance of one pattern, and naming the
pattern is more useful than the individual fix.

`packages/gate/src/checks.ts:1035` reads the replay id off the decoded token:

```ts
const jti = typeof l3a.jti === 'string' ? l3a.jti : null
if (jti === null) {
  return fail(7, chainInvalid('L3a carries no jti, so this authorisation cannot be replay-protected'))
}
```

**The pinned library contains zero occurrences of the string `jti`** — searched across every `.py` in
`verifiable_intent` at commit `356c296…`. It never sets a `jti` claim on any token, the L3 included.
`apps/vi` computes it as `base64url(SHA-256(L3a issuer JWT))` and returns it in the `l3/create` **HTTP
response**, which the Gate never sees.

So `jti` is always `null`, check 7 always fails closed, and **the Gate cannot ALLOW anything** — for a
second independent reason alongside the `l1: ''` / `l2: ''` defect. The UNIQUE index on
`checkout_attempts.l3_jti` cannot fire, because the value it would key on is never populated.

**The fix is to compute the id in the Gate from the L3a bytes**, which is a pure function and exactly
the property check 7 needs: the same signed L3 twice yields the same id. It is not read from a claim.

**And the pattern, which is the real finding.** This is the fourth defect in a row with the same
shape:

| Defect | Test that should have caught it | Why it did not |
|---|---|---|
| SD-JWT disclosure withheld | a completeness test over real tokens | fixtures, not presented tokens |
| `l1: ''` / `l2: ''` | a real `ViClient` request check | `deps.ts` in-memory world skips the schema |
| signed budget unenforced | a test with a budget in the L2 | fixtures carried no constraint |
| `jti` never present | a test decoding a real L3a | fixtures carried a `jti` the library never emits |

**Every one of these is invisible to a test whose fixture is hand-built to be convenient.** The
fixtures are not wrong; they are *unrepresentative*, and they were all written to make an assertion
easy rather than to match what the pinned dependency actually produces. The remediation is not more
unit tests. It is a standing rule that **any test touching a pinned dependency boundary must
consume a value that dependency actually produced** — captured through its own routes, as
`packages/gate/test/fixtures/vi-verify-budget-capture.json` now is.
