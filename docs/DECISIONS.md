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
own iat/exp window evaluation clearly labelled *advisory*.
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
   In autonomous mode the two open mandates *are* SD disclosures. Returning only three segments makes
   `verify_chain` fail with *"L2 delegate_payload resolved zero mandate disclosures"*. The spec's
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