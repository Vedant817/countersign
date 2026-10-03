# PROGRESS — Countersign work packages

Status legend: `todo` · `wip` · `review` · `done` · `blocked` · `dropped`

"Finishing commit" is the merge/`--no-ff` commit hash that closed the package on `main`.

Legend for lanes: **A** platform/CI/docs · **B** crypto/Gate/verifier · **C** PayPal rails ·
**D** intent/agent/UI-buyers · **E** disputes/merchant UI.

---

## Critical path

`WP-00 → WP-01 → WP-06 → WP-06s (week-1 checks) → WP-11 → WP-15e → WP-20 → WP-22`

---

## Work packages (spec §15)

| WP | Title | Lane | Deps | Size | Status | Finishing commit | Acceptance |
|---|---|---|---|---|---|---|---|
| WP-00 | Repo scaffold, CI, Render blueprint, AGENTS.md | A | n/a | 3h | done | _(see git log)_ | AT-WP00 |
| WP-01 | `packages/core` — ids, money, errors, clock | A | 00 | 3h | todo | | AT-M1 |
| WP-02 | `packages/db` — schema + migrations + seed | A | 01 | 4h | todo | | AT-M2 |
| WP-03 | `apps/vi` — vi-service (Python FastAPI) | B | 00 | 8h | todo | | AT-M3 |
| WP-04 | `packages/vi-client` | B | 01, 03 | 2h | todo | | AT-M4 |
| WP-05 | Browser keystore + WebAuthn step-up | B | 04 | 5h | todo | | AT-M5 · **C3(a)** |
| WP-06 | `packages/paypal` — typed REST client | C | 01 | 10h | todo | | AT-M6 |
| WP-06s | Sandbox scripts + week-1 checks C1, C2, C3(b) | C | 06 | 4h | blocked | | `docs/week1-results.md` (needs H-01) |
| WP-07 | Vault onboarding + L1 issuance | C | 02, 05, 06 | 5h | blocked | | AT-M7 (needs H-01) |
| WP-08 | Intent compiler + deterministic read-back | D | 01, 02 | 6h | todo | | AT-M8 (needs H-02) |
| WP-09 | Catalog, checkout JWT, price lock, stock | D | 02, 04 | 5h | todo | | AT-M9 |
| WP-10 | `packages/gate` + budget ledger | B | 02, 04, 09 | 8h | todo | | AT-M10 |
| WP-11 | `packages/orders` — order orchestrator | C | 06, 10 | 8h | blocked | | AT-M11 (needs H-01) |
| WP-12 | `packages/webhooks` + reconciler + worker | C | 06, 02 | 6h | todo | | AT-M12 |
| WP-13 | `packages/agent` — shopping agent + injection defences | D | 09, 14, 04 | 8h | todo | | AT-M13 |
| WP-14 | Merchant MCP server | D | 09 | 3h | todo | | AT-M14 |
| WP-15a | Liability router (pure) | E | 01, 02 | 5h | todo | | AT-M15.1 + 40-case eval |
| WP-15b | Evidence planner (reason → evidence enum) | E | 15a | 3h | todo | | AT-M15.2 |
| WP-15c | Drafter + citation checker | E | 15b | 5h | todo | | AT-M15.3 |
| WP-15d | Evidence PDF + QR | E | 15b | 5h | todo | | AT-M15.4 |
| WP-15e | Filer + dispute ingest + Defender agent | E | 06, 12, 15c, 15d | 6h | todo | | AT-M15 (J3) |
| WP-16 | Strategist + dispute lifecycle actions | E | 15e | 5h | todo | | AT-M16 |
| WP-17a | Wallet UI (S-02…S-09) | D | 05, 07, 08 | 8h | todo | | E2E + axe |
| WP-17b | Agent chat UI (S-10) | D | 13 | 4h | todo | | E2E |
| WP-17c | Shop UI (S-11…S-13) | D | 09 | 3h | todo | | E2E |
| WP-17d | Merchant UI (S-14…S-16, S-19) | E | 11, 10 | 6h | todo | | E2E |
| WP-17e | Disputes UI + Bryntum timeline (S-17, S-18) | E | 15e | 6h | todo | | E2E + table fallback |
| WP-17f | Landing, status, design polish | A | 17a–e | 4h | todo | | Lighthouse ≥ 90 a11y |
| WP-18 | Public verifier `/v/[packetId]` | B | 03, 15d | 3h | todo | | AT-M18 |
| WP-19 | Privacy, logging, audit, status | A | 02, 12 | 5h | todo | | AT-M19 |
| WP-20 | Evals + Judge Mode | A | 11, 13, 15e | 6h | todo | | J1–J4 green ×20 |
| WP-21 | Edge-case sweep: every §12 row tested | all | all | 10h | todo | | `pnpm test:ec` = 109/109 |
| WP-22 | Docs, README, Devpost assets, video shot list | A | 20 | 6h | todo | | §19–§20 checklists |

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

- **2026-10-04** — Step 0 done: repo initialised on `main`, spec moved to `docs/spec/`, `.gitignore`,
  `AGENTS.md`, `docs/HUMAN_TODO.md`, `docs/PROGRESS.md`, `docs/DECISIONS.md` created.
  Human-only steps H-01…H-07 are open. WP-00 scaffold starting.