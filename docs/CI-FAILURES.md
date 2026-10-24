# CI failures on `main`, diagnosed 25 October 2026

`main` was red for its entire life and the reports did not say why. Three separate causes, in the order
they were found, plus the edge-case gate. **All are fixed**; the fixes are named below so the next
person does not have to rediscover them. (`fix/p0-12-ci-green`; see
`docs/verification/p0-12-ci-green.md`.)

## Fixed — the VI pin gate could never pass

`.github/workflows/ci.yml`, step _"assert the pinned VI library is the one we think it is"_:

```sh
ACTUAL=$(uv pip show verifiable-intent 2>/dev/null | sed -n 's/^Direct-URL: //p' || true)
```

`uv pip show` prints `Name`, `Version`, `Location`, `Requires` and `Required-by`. It prints **no
`Direct-URL:` line at all** — verified locally and against the failing run. `ACTUAL` was therefore always
empty, the `case` always fell through, and the gate failed unconditionally from the day it was written.

The pin it guards was correct. That is luck, not enforcement.

Now reads `direct_url.json` (PEP 610) and `vcs_info.commit_id`, with the dist-info directory resolved
through `sysconfig.get_paths()` rather than hard-coded, because the `lib`/`lib64` split differs by
platform and a hard-coded path is how this class of check silently stops looking at anything. Fixed in
`cfab23c`.

## Fixed — every job died in `setup-node`

All four jobs failed at `Run actions/setup-node@v5` with:

```
Unable to locate executable file: pnpm
```

`actions/setup-node` with `cache: pnpm` runs `pnpm store path` **during its own setup step** to locate
the cache directory, so pnpm must already exist. Every job had `corepack enable` _after_ it — always too
late. Moving `corepack enable` earlier is not the fix either: `setup-node` switches the Node
installation and the shims corepack wrote into the previous one's bin directory go with it.

Now `pnpm/action-setup@v4` (no `version` argument, so `packageManager` stays the single declaration)
precedes `setup-node`. Fixed in `fba6b57`. Verified: job wall time went from **7s to 2m13s**, i.e. the
gates now actually execute.

**This is why the other two went unnoticed.** A repository whose every job dies in setup reports the same
red X for a passing suite and a broken one.

## Fixed — `verifier/test/qa4-checkout-parity.test.ts`, 4 failures

```
AssertionError: expected -1 to be +0        ← verify.py exited -1, not 0
AssertionError: expected '' to contain '[FAIL] checkout_binding'
```

`verify.py` produces no output and exits `-1`, which is the shell's "not found / not executable" rather
than a verification verdict. Most likely `python` is absent under that name on the runner, or the
downloaded script is not marked executable. **Not investigated** — the fix depends on which of those it
is, and guessing would replace one wrong answer with another.

Note this is the `EC-PRICE-1 / AT-M18.1` evidence, so it is a §12 acceptance test, not a nice-to-have.

**Cause, found:** neither. The interpreter was `uv`, and `test-node` never installed it.
`execFileSync` threw `ENOENT`, `e.status` was `null`, and `e.status ?? -1` reported that as `-1` with
empty stdout. Fixed by installing uv (0.12.22) and syncing `apps/vi` in `test-node`; the test helper
now throws with the spawn error instead of returning a verdict-shaped `-1`.

## Fixed — `defender/test/filer.test.ts`, 5 failures, all in _"the posture gate: the source-scan half"_

```
provideEvidence is called in exactly one place in src/, and it is behind a permit
uploadPermitFor is the only permit constructor and is called from exactly one place
the strategist has no provideEvidence anywhere: not in its types, its actions, or its port
no file in src/ imports a model runtime, and none uses `as any`
filer.ts takes its model as an injected one-function port, never an SDK
```

All five **pass locally on Windows** and fail on `ubuntu-latest`. That asymmetry is the clue: these
tests read source files, so the difference is almost certainly path separators or a glob that behaves
differently on Linux. Same class as the `capOf()` bug in `docs/COMPILER-EVAL.md` — a check that reports
success without exercising what it claims to.

**A source-scan gate that passes on one platform and fails on another is not a gate.** Worth fixing by
making the file discovery explicit rather than by adjusting the assertion.

**Cause, confirmed from the run log:** `new URL('../src/', import.meta.url).pathname.replace(/^\//, '')`.
On Windows the pathname is `/C:/…` and the strip leaves a valid absolute path; on Linux it is
`/home/runner/…` and the strip leaves the relative path `home/runner/…`, so every scan died with
`ENOENT: scandir 'home/runner/work/countersign/countersign/packages/defender/src/'`. Fixed with
`fileURLToPath` and an explicit recursive `readdirSync` walk; no expected value changed.

## Fixed — `edge-case ledger is complete`

```
FAIL  19 case(s) have no referencing test and are not marked blocked
```

By design: this is WP-21's acceptance criterion and it is not met. See `docs/EDGE_CASES.md`.

**Fixed:** `pnpm test:ec` exits 0 — 105/109 cases have a referencing test, 2 are dropped as out of scope
by the spec itself (EC-PRICE-3, EC-FAM-3) and 2 are blocked with the blocker named (EC-ENV-3, EC-LLM-4).
15 of the 19 gained real tests; the `wip` rows carry a note saying which half is missing. Executing the
two database cases against a real Postgres immediately found four `Date`-in-raw-`sql` runtime failures
and a string/BigInt mismatch in money readers — see `docs/verification/p0-12-ci-green.md`.

## Fixed — `all gates green` could never pass

```
RESULT="Array"
FAIL: at least one gate did not pass.
```

`RESULT="${{ needs.*.result }}"` renders as the literal string `Array` when a dependency is a matrix job
(`test-node` runs three shards), so `echo "Array" | grep -qv success` always matched and the aggregate
gate failed unconditionally — since the day it was written. Run `40132768178` shows it plainly: every
substantive job green, only this one red. It is the same class of defect as the VI pin (`sed` matching
no line) and the defender source scan (a path that did not exist): **a gate that reports failure
without testing anything.** It is now read from `toJSON(needs)`, and a skipped dependency counts as a
failure.

## Fixed — gitleaks needs a token and `pull-requests: read` on PR events

The first pull-request-triggered run failed with _"GITHUB_TOKEN is now required to scan pull requests"_;
with the token supplied it failed with `403 Resource not accessible by integration` on
`GET /repos/{owner}/{repo}/pulls/{n}/commits`, whose `x-accepted-github-permissions` header asks for
`pull_requests=read`. Every push-triggered run had passed, so the gap only appeared once this repository
had a pull request. The workflow now supplies `secrets.GITHUB_TOKEN` and grants `pull-requests: read`;
the scan itself is unchanged.
