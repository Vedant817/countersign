# P0-12 — CI green

**Branch:** `fix/p0-12-ci-green` · **Date:** 2026-10-25

Three CI failures were open in `docs/CI-FAILURES.md`. Each is fixed by its cause, not by relaxing an
assertion; none of the fixes is a skip. The verified run URL is appended when the branch is pushed.

## 1. `packages/verifier/test/qa4-checkout-parity.test.ts` — exit `-1`, empty stdout

**Cause (not a guess):** `test-node` never installed `uv`. `execFileSync('uv', …)` threw `ENOENT`,
`e.status` was `null`, and `e.status ?? -1` reported `-1` with no stdout — the shim's "not found"
reading as a verification verdict. Evidence: `.github/workflows/ci.yml` had no `setup-uv` step in
that job; run `40128373231` shows `expected -1 to be +0` on all four Python-executing cases, and
`verify-py.test.ts`'s whole execution suite skipped for the same reason.

**Fix:** the job installs uv (0.12.22, same pin as `test-python`) and syncs the pinned Verifiable
Intent project before `pnpm test:ci`. The helper now throws with the spawn error when `uv` is absent
and attaches the interpreter's stderr to a failed run, so a missing prerequisite can never again be
reported as a script verdict.

**Proof:** `pnpm test -- packages/verifier/test/qa4-checkout-parity.test.ts` → 5 passed locally.

## 2. `packages/defender/test/filer.test.ts` — 5 Linux-only failures

**Cause:** `new URL('../src/', import.meta.url).pathname.replace(/^\//, '')`. On Windows the pathname
is `/C:/…` and the strip leaves a valid absolute path; on Linux it is `/home/runner/…` and the strip
leaves the relative path `home/runner/…`. Every scan died with
`ENOENT: scandir 'home/runner/work/countersign/countersign/packages/defender/src/'` (run `40128373231`, job `tests (node, 3/3)`).

**Fix:** `fileURLToPath` for the conversion, and an explicit recursive `readdirSync` walk so the file
set is identical on both platforms and a file in a subdirectory cannot silently escape the gate.
No expected value changed.

**Proof:** `pnpm test -- packages/defender/test/filer.test.ts` → 72 passed locally. Linux is proven by
the CI run itself.

## 3. The edge-case ledger — 19 rows with no test

`pnpm test:ec` now exits 0: **105/109** cases have a referencing test. Of the 19:

- **15 gained real tests**, several of which found genuine defects:
  - EC-BUY-6 and EC-AGT-4 execute against Postgres (`packages/db/test/repos.edge-cases.live.test.ts`);
    writing them found **four `Date`-in-raw-`sql` runtime failures** (`countDisputesForWalletSince`,
    `findDisputesUpdatedSince`, `walletSpendInPeriod` — Gate check 9 — and `countCommitsSince` —
    Gate check 11) and a **string/BigInt mismatch** (`sumEntriesByKind` → `computeFromEntries`,
    `walletSpendInPeriod`, `sumCapturedForAuthorization`). Fixed in `23e8c65`; `db-migrations` now
    runs the suite so they stay fixed.
  - EC-BUY-2, EC-LLM-3 (router/citation), EC-MA-3 (gate), EC-SPLIT-3 (defender ingest),
    EC-ENV-2 (paypal sandbox surface), EC-FX-2 (capture breakdown), EC-LLM-5 (model env),
    EC-FAM-1 (WebAuthn step-up), EC-PP-4 (MCP down / REST sweep), EC-PP-3, EC-KEY-1, EC-FAM-2,
    EC-MDT-7 (mandate immutability, proven to fail by mutation).
- **2 are dropped as out of scope by the spec itself:** EC-PRICE-3 ("No automatic action (out of
  scope)") and EC-FAM-3 ("(P2)"). Reasons are in `docs/edge-cases.json`; `scripts/ec-coverage.mjs`
  no longer renders `dropped` as `todo`.
- **2 are blocked, with the blocker named:** EC-ENV-3 (no `scripts/sandbox-bootstrap.ts`, no daily J1
  health job, and `sandbox-nightly.yml` calls a `pnpm judge` script no package defines — needs the
  public deployment and real sandbox) and EC-LLM-4 (`packages/agent` is still `export {}`, so there is
  no loop to cap).

The `wip` rows carry notes naming exactly which half is missing, so the published ledger cannot be read
as "covered" for the parts that are not built.

## Other findings recorded rather than worked around

- **EC-AGT-4 vs Gate check 2** — the spec says a rotation leaves old mandates spendable; `rotateAgentKey`
  marks the predecessor `REVOKED` and the Gate refuses any non-`ACTIVE` agent. Contract issue **10**.
- **`sandbox-nightly.yml`** invokes `pnpm judge`, which no package defines, and runs at 00:00 IST rather
  than the spec's 06:00. Not fixed here (it needs the Judge Mode runner, WP-20); noted in the EC-ENV-3
  blocked reason.

## Two more CI defects, found by this PR's own runs

1. **`all gates green` could never pass.** `RESULT="${{ needs.*.result }}"` renders as the literal
   string `Array` when a dependency is a matrix job (test-node has three shards), so
   `grep -qv success` always matched. Run `40132768178` proves it independently: every substantive job
   green, only `all gates green` red, with `RESULT="Array"` in its log. Same class as the VI pin and
   the source scan — a gate that reports failure without testing anything. Now reads `toJSON(needs)`
   and selects any result that is not `success`.
2. **`gitleaks-action@v2` needs a token on pull requests.** The first PR-triggered run failed with
   _"GITHUB_TOKEN is now required to scan pull requests"_; with the token supplied, it then failed with
   `403 Resource not accessible by integration` on `GET /pulls/1/commits`, whose
   `x-accepted-github-permissions` header asks for `pull_requests=read`. Both were invisible on `main`
   because every push run passed. The workflow now supplies the automatic token and grants
   `pull-requests: read`. The scan is unchanged; nothing was skipped.

## Local gate

```
pnpm typecheck        ✓
pnpm lint             ✓
pnpm format:check     ✓
pnpm test             ✓  104 files, 2745 passed, 10 skipped
pnpm test:ec          ✓  105/109 with a test; 2 dropped, 2 blocked with reasons
pnpm secret-scan      ✓  no leaks (280 commits)
pnpm --filter @countersign/db exec vitest run   ✓  75 passed (DATABASE_URL set)
```

## CI

**Green:** [`40133232250`](https://github.com/Vedant817/countersign/actions/runs/40133232250) on
`fix/p0-12-ci-green` — all nine checks passed on `ubuntu-latest`:

```
✓ typecheck · lint · format · money · edge cases   (pnpm test:ec exit 0 in CI)
✓ migrations + seed against postgres 17            (incl. the db package suite)
✓ tests (node, 1/3) ✓ (node, 2/3) ✓ (node, 3/3)    (incl. the uv-provisioned parity tests)
✓ tests (vi-service)
✓ secret scan
✓ build (web + packages + worker)
✓ all gates green
```

PR: https://github.com/Vedant817/countersign/pull/1 (open; not merged — merging is the lead's call).
Earlier red runs, for the record: `40131911492` (gitleaks token), `40132334635` (gitleaks permission),
`40132768178` (aggregate gate), all of them green in every other job.
