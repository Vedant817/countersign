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
| WP-12 | `packages/webhooks` + reconciler + worker | C | 06, 02 | todo | | AT-M12 |
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