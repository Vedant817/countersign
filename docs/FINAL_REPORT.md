# Main integration and app verification report

Date: 24 October 2026 (IST). Integration merges: `ea2124d`, `4809239`, current verified `main`: `0878bd3`.

## What is on `main`

All local work branches are merged. The first integration (`ea2124d`) combined WP-14's merchant MCP
transport (`cbdce9e`) with WP-11's outstanding binder commits, including the orchestrator composition
root (`e0fb068`); documentation conflicts were resolved by keeping both sides and the binder's
duplicate D-044 was renumbered D-047.

The second (`4809239`) merged `wp/17f-user-journey-hardening`, which carried three work packages that
had not yet reached `main` — WP-09 digital shipping (`14c6bec`), WP-09 merchant persistence (`4951202`,
`e9557bf`) and WP-14 MCP hardening (`0fc383a`, `e446fbb`, `64bbe86`) — plus the user-journey repair
pass (`c297511`), its integration fixes (`4446fac`) and the local launcher and event research
(`d0fe7ea`). Decisions **D-048**…**D-051** record the four substantive changes:

- **D-048** — the reachable MCP endpoint no longer composes the in-memory Gate world. Catalog and price
  lock work; `submit_checkout` and `get_order_status` refuse with `CS_INTERNAL` until a tenant-bound,
  persisted runtime is composed. A test world's seeded principals, budgets and unsigned decisions must
  never become authority on a reachable endpoint, so AT-M14's purchase round-trip is **deliberately
  incomplete** rather than demonstrated against a fixture.
- **D-049** — the storefront requires `DATABASE_URL`. Seed browsing is an explicit non-production
  opt-in (`COUNTERSIGN_DEMO_CATALOG=1`) that never confers purchase authority; production ignores it,
  and a configured-but-unreachable database returns repository errors instead of falling back to seeds.
- **D-050** — digital-only carts are never charged physical shipping, and a cart needing delivery in a
  currency the store has no rate for is refused rather than converted (EC-FX-1).
- **D-051** — the device-signing lab requires an explicit flag, a non-production environment, a
  loopback host and a same-origin request.

## Local validation at `d0fe7ea` / `4809239` / `0878bd3`

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm secret-scan`, `pnpm build` —
  all pass. Money discipline: clean, 128 files across 15 roots. Secret scan: 203 commits, no leaks.
- TypeScript suite: **94 files, 2,665 tests** (89 files / 2,536 at `ea2124d`; 91 / 2,610 at `4809239`).
- Python VI suite: **207 tests**, with `ruff check` and `ruff format --check` clean.
- Production build: Next 16.3.8, **16 routes** generated.
- Chromium E2E: **14 tests passed** against the running app, the real local VI service and a real
  seeded PostgreSQL — non-extractable device keys, L2 signing, lost-key recovery, P1363 signatures,
  catalog search, injection labelling, checkout price locking, mobile navigation and styling,
  unsupported-currency disclosure, expired-quote re-quote preserving quantity and country, malformed
  form handling, digital-only zero shipping, escaped untrusted markup, and the narrow-viewport
  `/status` page.
- Real-database check (not doubles): a quote created over HTTP was decoded in a **fresh process** with
  the exact bigint cart, and a failed stock transaction rolled back in PostgreSQL.
- The round-2 review produced exactly two findings; both are fixed and now regression-tested — `/status`
  no longer overflows at 360 px and carries shared navigation, and the pre-hydration countdown no
  longer implies a mandate check that never happens.

## WP-19 shipped, and three review findings closed

`@countersign/privacy` (merge `0878bd3`) implements M19 as pure functions and ports: the §12.13
retention table as data, `planErasure` for the legal-hold decision, `pseudonymiseUser` for what
"erased" means for a row, the 48-hour DPDP notice, the subject-access export, the prompt allow-list
and the cross-border statement. **49 offline tests**, no credentials required. AT-M19.1 is covered
end to end, including the case a weak implementation gets wrong — resolution releases the dispute
hold but **not** the 540-day evidence window, so a closed case inside the window stays held with a
date rather than being deleted.

An independent review round (delegated to a second model) confirmed the `/status` mobile fix and
found three defects the automated suite could not see, because all three need a misconfigured or
moved deployment rather than a test double. All three are fixed with regression tests (D-052, D-053):

1. A different service listening on the vi port made a price lock report _"We could not find that. It
   may have been removed."_ for an in-stock item — `packages/vi-client` was inferring `CS_NOT_FOUND`
   from a 404 that provably did not come from vi.
2. Every `/v/<packetId>` URL returned a 500 when `PUBLIC_BASE_URL` was unset, including
   `/v/not-a-packet`, which EC-DSP-9 makes a 404.
3. `/status` described a running process as one that "should have refused" to boot, because it
   treated "not sandbox" and "not set" as the same fact.

The review's remaining blocker was environmental: the local vi-service had stopped and a stray
process was serving port 8000, which is why it could not complete a quote. The Chromium E2E suite had
passed **14/14** against the real service earlier in the same session.

## The complete payment app is not operational

In the normal app environment `/status` returns 503: Postgres, VI and PayPal OAuth are unconfigured.
The E2E suite supplies its own local VI configuration, so its success does not prove a normal
deployment is configured. No secrets were requested or added during verification.

Concretely, the following are **not** true and are not claimed:

- No successful purchase, no live PayPal transaction, no hosted deployment, no CI acceptance.
- No ALLOW can create a PayPal order: order lookup has no persisted order source, and the MCP endpoint
  refuses submission outright (D-048). The remaining composition work is itemised in
  [contract issues](contract-issues.md).
- Buyer onboarding, agent chat, merchant workspace, the disputes UI and the Judge Mode scenario runner
  are unfinished, as are WP-13 (shopping agent), WP-17a/17b/17d/17e, WP-20 and WP-22. WP-19 is `wip`:
  its acceptance and its §12 rows are covered, but the purge sweep job that would call the retention
  deadlines is not written, and `webhookHealth` is not yet wired into `/status`.
- `pnpm test:ec` is **red by design, not by accident**: 19 of the 109 §12 edge cases have no
  referencing test, and most of them need a work package that is still `todo` (agent/injection,
  live-sandbox) rather than a test someone forgot. WP-21 tracks this. Two further rows (`EC-IDEM-4`,
  `EC-MER-1`) have tests but are still `status: todo` in the ledger.
- Lighthouse accessibility (WP-17f's acceptance bar) has not been measured.

Existing human setup requirements remain in [HUMAN_TODO.md](HUMAN_TODO.md).

## Corrections made while verifying

- `EC-OPS-1` was cited by four tests in `packages/core` but exists nowhere in spec §12 — the ledger
  overstating itself, which is the failure mode D-017 warns about. The id is gone; the tests remain.
- `docs/EDGE_CASES.md` was a 2026-10-07 snapshot; it has been regenerated (557 references, 87/109
  cases referenced).
- The worker's `lazy.test.ts` citation was stale — `WORKER-3` lives in `test/worker.test.ts` — and the
  test table listed three of six files (fixed `0dff747`).

Details: [web README](../apps/web/README.md), [scan triage](verification/secret-scan-triage.md),
[MCP boundary](verification/mcp-hardening.md), [merchant persistence](verification/merchant-persistence.md),
[transport checks](EDGE-CASES.md), and decisions [D-046](DECISIONS.md#d-046) and
[D-048](DECISIONS.md#d-048).
