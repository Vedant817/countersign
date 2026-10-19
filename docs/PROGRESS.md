# PROGRESS — Countersign work packages

Status legend: `todo` · `wip` · `review` · `done` · `blocked` · `dropped`

"Finishing commit" is the commit hash that closed the package.

Lanes: **A** platform/CI/docs · **B** crypto/Gate/verifier · **C** PayPal rails ·
**D** intent/agent/UI-buyers · **E** disputes/merchant UI.

---

## Critical path

`WP-00 → WP-01 → WP-06 → WP-06s (week-1 checks) → WP-11 → WP-15e → WP-20 → WP-22`

`WP-06s` onward needs a human (H-01 PayPal sandbox, H-09 dispute-scopes). Everything above it is
buildable now.

---

## Work packages (spec §15)

| WP | Title | Lane | Deps | Status | Commit | Acceptance |
|---|---|---|---|---|---|---|
| WP-00 | Repo scaffold, CI, Render blueprint, AGENTS.md | A | n/a | done | `4c60f4d` | AT-WP00 ✅ |
| WP-01 | `packages/core` — ids, money, errors, clock | A | 00 | done | `1620777` | AT-M1 ✅ 90 |
| WP-02 | `packages/db` — schema + migrations + seed | A | 01 | done | `4e0ce4c` | AT-M2 ✅ 64 |
| WP-03 | `apps/vi` — vi-service (Python FastAPI) | B | 00 | done | `9561807` | AT-M3 ✅ 183 |
| WP-04 | `packages/vi-client` | B | 01, 03 | done | `aceecf7` | AT-M4 ✅ 185 + 11 contract |
| WP-05 | Browser keystore + WebAuthn step-up | B | 04 | todo | | AT-M5 · **C3(a)** |
| WP-06 | `packages/paypal` — typed REST client | C | 01 | done | `44207bf` | AT-M6 ✅ 271 |
| WP-06s | Sandbox scripts + week-1 checks C1, C2, C3(b) | C | 06 | blocked | | needs H-01, H-09, H-10 |
| WP-07 | Vault onboarding + L1 issuance | C | 02, 05, 06 | blocked | | AT-M7 (H-01, WP-05) |
| WP-08 | Intent compiler + deterministic read-back | D | 01, 02 | done | `80a9ff5` | AT-M8 ✅ 285 |
| WP-09 | Catalog, checkout JWT, price lock, stock | D | 02, 04 | done | `27f3e12` | AT-M9 ✅ 34 (D-020) |
| WP-10 | `packages/gate` + budget ledger | B | 02, 04, 09 | done | `27f3e12` | AT-M10 ✅ 162 |
| WP-11 | `packages/orders` — order orchestrator | C | 06, 10 | todo | | AT-M11 (H-01 for live) |
| WP-12 | `packages/webhooks` + reconciler + worker | C | 06, 02 | done | `beb5f3d` | AT-M12 ✅ 154 · worker 116 |
| WP-13 | `packages/agent` — shopping agent + injection defences | D | 09, 14, 04 | todo | | AT-M13 |
| WP-14 | Merchant MCP server | D | 09 | todo | | AT-M14 |
| WP-15a | Liability router (pure) | E | 01, 02 | todo | | AT-M15.1 + 40-case eval |
| WP-15b | Evidence planner (reason → evidence enum) | E | 15a | todo | | AT-M15.2 |
| WP-15c | Drafter + citation checker | E | 15b | todo | | AT-M15.3 |
| WP-15d | Evidence PDF + QR | E | 15b | todo | | AT-M15.4 |
| WP-15e | Filer + dispute ingest + Defender agent | E | 06, 12, 15c, 15d | todo | | AT-M15 (J3) |
| WP-16 | Strategist + dispute lifecycle actions | E | 15e | todo | | AT-M16 |
| WP-17a | Wallet UI (S-02…S-09) | D | 05, 07, 08 | todo | | E2E + axe |
| WP-17b | Agent chat UI (S-10) | D | 13 | todo | | E2E |
| WP-17c | Shop UI (S-11…S-13) | D | 09 | todo | | E2E |
| WP-17d | Merchant UI (S-14…S-16, S-19) | E | 11, 10 | todo | | E2E |
| WP-17e | Disputes UI + Bryntum timeline (S-17, S-18) | E | 15e | todo | | E2E + table fallback |
| WP-17f | Landing, status, design polish | A | 17a–e | todo | | Lighthouse ≥ 90 a11y |
| WP-18 | Public verifier `/v/[packetId]` | B | 03, 15d | todo | | AT-M18 |
| WP-19 | Privacy, logging, audit, status | A | 02, 12 | todo | | AT-M19 |
| WP-20 | Evals + Judge Mode | A | 11, 13, 15e | todo | | J1–J4 green ×20 |
| WP-21 | Edge-case sweep: every §12 row tested | all | all | todo | | `pnpm test:ec` = 109/109 |
| WP-22 | Docs, README, Devpost assets, video shot list | A | 20 | todo | | §19–§20 checklists |

WP-15e is **not** blocked: its code and tests can be built against the PayPal client's verified
schemas. Only the live `adjudicate` needs H-01.

---

## Definition of done (whole project)

- [ ] every WP above is `done` and merged
- [ ] all 109 §12 edge cases handled and tested (`docs/EDGE_CASES.md`)
- [ ] CI green
- [ ] deployed on Render, full demo flow runs in the PayPal sandbox from a clean seed
- [ ] all 4 Judge Mode scenarios pass end to end
- [ ] README lets a judge run it locally and online in under 10 minutes
- [ ] Apache-2.0 licence present
- [ ] all 48 judge questions answered with a code/test link (`docs/JUDGE_QA.md`)
- [ ] submission checklist (spec §20) complete
- [ ] `git status` clean, everything committed and pushed

---

## Status log

- **2026-10-04** — Step 0: repo on `main`, spec in `docs/spec/`, `AGENTS.md`, and the tracking docs.
  All 26 pinned versions in spec §4 verified against npm and PyPI, and the pinned VI commit confirmed
  on GitHub (D-003).
- **2026-10-04** — **WP-01 `packages/core`**. 90 tests. Nine bugs found by its own tests, including
  `csError` silently dropping `details` at every call site (D-005) and `ppAmountSchema` hardcoding USD
  instead of reading `currency_code`, so `"500.00"` passed for JPY (D-004).
- **2026-10-04** — **WP-02 `packages/db`**. 26 tables, 27 enums, 16 CHECKs, 17 unique indexes. Two bugs
  found while verifying: drizzle-kit cannot serialise a BigInt default; pre-quoted pg-boss identifiers
  rendered as literal `""retryLimit""` column names.
- **2026-10-04** — **WP-03 `apps/vi`**. 183 tests, all eleven AT-M3. Raised D-007…D-011. Most
  consequential: the pinned library's `verify_chain` has no clock override, so **EC-TIME-3 is flagged
  `blocked` rather than faked** — a fabricated as-of verdict would end up inside evidence filed with
  PayPal (HUMAN_TODO H-08 asks upstream).
- **2026-10-04** — **WP-06 `packages/paypal`**. 271 tests, 12 live-sandbox tests gated. A follow-up
  audit against PayPal's published OpenAPI found **31 corrections, four of them fabricated field
  names** in the sandbox simulators that would have failed live in Judge Mode J3 (D-012…D-016). The
  audit is kept verbatim at `docs/verification/paypal-api-2026-10-04.md`. It also answered **week-1
  check C2**: the vault `AUTHORIZE` path returns the authorization **inline**.
- **2026-10-04** — **WP-00**. `.env.example`, `docker-compose.yml`, `render.yaml`, `ci.yml`,
  `sandbox-nightly.yml`, `.gitleaks.toml`, and a root vitest workspace so CI shards the suite.
- **2026-10-04** — **WP-04 `packages/vi-client`**. 185 tests plus 11 contract tests, the latter run
  against a **real** vi-service (issue L1 → prepare → sign → finalize → verify). Building the client
  surfaced the most dangerous shape bug in the project: `constraints.skipped` was a list of strings with
  reasons appended, so a Gate's `skipped.includes('mandate.payment.budget')` was **`false` while a
  signed budget cap sat unevaluated** — it would have failed **open**, in favour of spending. Now
  `{type, reason}[]` with a `.transform()` so the mistake is a **type error** (D-019).
- **2026-10-04** — **WP-08 `packages/compiler`**. 285 tests. The read-back is the string a user signs,
  so it is pure (no model, no clock, no I/O) and pinned byte-identical across 50 calls and reordered
  inputs. Every one of the 8 constraint types has a template, including the two network-enforced ones.
- **2026-10-04** — **WP-09 + WP-10** merged into one package (`packages/gate/src/merchant/`, D-020)
  because Gate checks 5 and 6 read exactly the values the catalog produces. 162 tests including a
  20-way race yielding exactly 3 ALLOWs and 2,000 L3 bit-flips yielding 0 ALLOWs. Three real bugs
  fixed: the **wallet cap double-counted the current attempt** so the effective cap was `cap − cart`
  (D-021); `verifyDecisionRecord` defaulted `nowSec` to the wall clock, an intermittent failure that
  would have surfaced during judging rather than CI; and `create_checkout` sent a line total where vi
  expects a unit price, which would have double-priced a two-unit cart into a merchant-signed JWT.

**Edge-case ledger: 43 of 109 have a referencing test.** The definition of "covered" is in D-017, and
the scanner was twice found crediting references it should not have — both times the ledger
overstated itself, which is the failure mode that matters.

**Blocked on a human:** H-01 (PayPal sandbox app + keys), H-02 (OpenAI key), H-03 (Render),
H-04 (GitHub remote), H-08 (VI upstream clock override), H-09 (PayPal dispute-simulator scopes +
buyer consent), H-10 (PayPal `PayPal-Request-Id` length). Everything from WP-00 to WP-10 is built;
WP-06s and everything needing live sandbox is not started.

- **2026-10-16** — **Landed 16 commits that had been written but never reached `main`.** The branch
  `wp/10-gate-disclosed-payment-review` held them; `main` was still at `4c60f4d`'s successor `2012b0d`
  and the reflog showed the earlier merge attempt had checked out `main` and returned without merging.
  Also recovered and committed **197 insertions of uncommitted work** that existed only in the working
  tree — the Gate's replay-id derivation from the issuer bytes with its captured-token fixture test, and
  the worker's `settleRequiredWork` (a job that could not finish is retried, not acknowledged). It was
  green, so it was verified and committed rather than described as mine.
- **2026-10-16** — **`gate_decisions` had a writer definition and no caller.** `OrchestratorStore` is the
  only port in `@countersign/orchestrator` with no other package's `deps.ts` to satisfy it, so the test
  harness's double was the only implementation — and `createOrderFromDecision` re-reads that row by id,
  refusing with `CS_NOT_FOUND`. Every `ALLOW` would have been followed by a failure and no order could
  ever exist. `orchestratorStoreFromRepos` is that writer (`5e492d7`). Three things it gets right that
  the obvious version does not: the two writes abort on error rather than committing an unlinked
  decision; a missing attempt row returns `ok(undefined)` having written nothing, read *before* the
  insert because `repo()` turns a throw into a returned `err`; and `chain_valid` is decoded out of the
  signed record rather than derived, because the harness double's hardcoded `true` would be a fabrication
  in production.
- **2026-10-16** — **The app layer is thinner than this table implies, and that is now stated rather
  than discovered late.** No app imports `gate`, `orders`, `defender`, `compiler`, `agent` or
  `orchestrator`. `apps/web` serves `/`, `/judge`, `/status` and `/v/[packetId]` — the verifier and a
  status page. The purchase path has no HTTP surface and the Gate has no call site in any app, so
  "the Gate allows a purchase end to end" means the orchestrator's own suite against in-memory ports,
  not a drivable product. `OrchestratorDeps` still needs `gateDepsFromRepos` +
  `orderStoreFromRepos` + a `BudgetStore` + `CompileDeps` assembled and handed to a route. That is the
  next piece of work, and it is why WP-13/14 and WP-17a–f remain genuinely unstarted.
- **2026-10-16** — **A stale `.d.ts` was failing `pnpm format:check`.** `apps/worker/test/harness.d.ts`
  carried a 2026-10-07 mtime and a full build does not regenerate it. `tsconfig.base.json` sets
  `declaration` + `declarationMap`, so any `tsc` run that does not inherit a `noEmit` over a
  `test/**/*.ts` include drops one beside the source. `git ls-files '*.d.ts'` returns 0 by design —
  packages ship declarations from `dist/`. Now ignored in both `.gitignore` and `.prettierignore`.
- **2026-10-20** — **Landed the D-039…D-043 hardening pass**, four commits of work that was written but
  uncommitted (`634bf70`, `5144295`, `2e1b9ad`, `16aed53`). One through-line in all five decisions:
  nothing signed into an artefact may be a value we did not determine. **D-039**: the Gate record no
  longer invents `amount`, `currency` and `payee` when the cart cannot be read — the payload fields are
  `null`-able, `verifyDecisionRecord` rejects empty strings in their place, and the verifier skips the
  payee binding rather than comparing against an invented one. **D-040/D-041**: `create_checkout` no
  longer signs the literal "Northwind Outfitters" / `https://northwind.example` regardless of the
  merchant, and shipping is priced in the cart's currency and refuses a currency this store does not
  quote (EC-FX-1: never convert) instead of summing USD minor units into a JPY total. **D-042**:
  `VI_ISSUER_URL` and `VI_AGENT_ISS` are required — the shipped default for the former was
  `https://www.mastercard.com`, so a process started without that variable signed Mastercard's identity
  into `iss` — and the `packages/core` env schema refuses any identity host under a reserved TLD;
  `render.yaml`, `docker-compose.yml`, `sandbox-nightly.yml` and `.env.example` were updated to declare
  or supply them. **D-043**: the landing and Judge Mode linked `/v`, `/wallet/onboarding`, `/agent` and
  `/merchant`, none of which is a route, so all four 404'd; the verifier is now named as
  `/v/<packet-id>` with where a judge can actually obtain an id (the QR code on the filed evidence PDF),
  and the persona buttons are cards that state what exists and what does not.
  The verifier and the orchestrator harness are inside `634bf70` rather than a commit of their own:
  `verify-view.ts` reads `payload.amount === null` and `harness.ts` throws on a null ALLOW, so changing
  the payload type without them would not typecheck.
- **2026-10-20** — **Verification for the landing.** Gate 68 passed (record, missing-subject, merchant);
  `packages/core` env 27 passed; vi-service 215 passed with `ruff check` and `ruff format --check` clean
  (pytest would not spawn until `uv sync --extra dev` — the dev extra was not installed in
  `apps/vi/.venv`); full suite 2515 passed | 36 skipped (2551) with lint, typecheck, build,
  `format:check` and `secret-scan` all green. The 30 that moved out of the skip column are
  `verify-py.test.ts`'s execution tests: they only run once `apps/vi/.venv` exists, so the same
  command on the same tree skipped them before `uv sync --extra dev` and runs them after.
- **2026-10-20** — **Verified WP-12 and corrected the worker's documentation.** The suites are 154 tests
  for `packages/webhooks` and 116 for `apps/worker` (`schedule` 17, `job-runner` 28, `worker` 9,
  `delivery` 42, `pg-boss-delivery` 11, `boot` 9), all green without credentials or a database, so the
  package is `done` at `beb5f3d`; the later worker fixes (`0fff1df`, `2012b0d`, `6fb14de`, `0f0a7a0`)
  are part of the verified state. `adapters.ts` supplies `WebhookStore` and `WebhookAudit` over
  `@countersign/db`, closing the exit-78 hole that stopped the process owning §8.10's reservation
  release, and the README now names the three reads still without a repository rather than claiming no
  production adapter exists. The `test/lazy.test.ts` citation was stale — `WORKER-3` lives in
  `test/worker.test.ts` — and the test table listed three of six files.
