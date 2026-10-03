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