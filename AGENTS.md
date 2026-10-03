# Countersign: provable intent for agent payments on PayPal

The authoritative specification for this repository is [`docs/spec/countersign-blueprint.md`](docs/spec/countersign-blueprint.md).
Section numbers quoted throughout the code (e.g. "§8.6", "EC-CAP-1", "D19") refer to it.

## Agent routing rules

| Deliverable | Write to |
|---|---|
| Status of a work package | `docs/PROGRESS.md` |
| A deviation from the spec | `docs/DECISIONS.md` (date, reason, evidence) |
| Where an edge case is handled / tested | `docs/EDGE-CASES.md` |
| Something only a human can do | `docs/HUMAN_TODO.md` (top of file) |
| Final report | `docs/FINAL_REPORT.md` |

## Git rules (hard)

1. One branch per work package: `wp/<id>-<slug>`. Merge into `main` with `--no-ff` **only** when its
   acceptance tests pass. `main` must always typecheck, lint, build and pass tests.
2. Commit continuously: after every meaningful, working unit. Small atomic commits, Conventional Commits
   (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`). Never leave more than ~30 minutes of
   work uncommitted.
3. **Never run destructive git commands**: no `git clean`, `git reset --hard`, `git checkout -- .`,
   no force-push, no `git stash drop`, no history rewriting. Never delete untracked work.
   To undo something, use `git revert` or a new commit.
4. Never commit secrets. Secrets come from environment variables only (spec §6). `.env*` is ignored
   except `.env.example`. A secret scan runs in CI and before every push.
5. Nothing lands without a typecheck, lint, format check, full test run, secret scan and a build.

## Engineering rules (spec §8.0)

1. **Read only what you need**: your WP (§15), the module contract (§8), the data model (§7), and the
   §12 edge-case rows tagged with your module.
2. **Shared types are owned centrally.** Public types live in `packages/core` and are **append-only**;
   only WP-01 may change one. Other work packages propose changes in their PR description.
3. **Error handling.** Never throw raw errors across a module boundary. Return `Result<T, CsError>` (TS)
   or raise an `HTTPException` with a `CsErrorBody` (Python). Every `CsError.code` comes from the
   registry in §8.1.
4. **No LLM output is authoritative.** LLM output is (a) validated by zod, (b) shown to a human, or
   (c) checked by deterministic code before any side effect.
5. **Never fake PayPal behaviour.** No mocking of PayPal outside `packages/paypal/test/fixtures`.
   Fixtures must be captured from real sandbox responses (`scripts/capture-fixture.ts`) and committed
   with the capture date.
6. **Idempotent side effects.** Every side-effecting PayPal call carries a deterministic
   `PayPal-Request-Id` derived from our own IDs (§8.6). Retrying any job must be safe.
7. **Definition of done** for a package: acceptance tests green in CI; every §12 case tagged to the
   module has a passing test; types exported; a README section in the package; no `any`;
   `pnpm lint && pnpm typecheck && pnpm test` pass.
8. **Don't edit another work package's files.** If a contract looks wrong, write
   `docs/contract-issues.md` and stub behind an interface.
9. **Money is integer minor units plus an ISO-4217 currency code.** Never a float.
10. **Time is UTC epoch seconds in tokens**, `timestamptz` in the database, IST only in the UI and in
    reports to Vedant.
11. **`packages/gate` must not import `ai` or `@ai-sdk/*`.** There is an ESLint rule enforcing it.