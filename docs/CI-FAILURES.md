# CI failures on `main`, diagnosed 25 October 2026

`main` was red for its entire life and the reports did not say why. Three separate causes, in the order
they were found. Two are fixed; **three remain open** and are named precisely below so the next person
does not have to rediscover them.

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

## Open — `verifier/test/qa4-checkout-parity.test.ts`, 4 failures

```
AssertionError: expected -1 to be +0        ← verify.py exited -1, not 0
AssertionError: expected '' to contain '[FAIL] checkout_binding'
```

`verify.py` produces no output and exits `-1`, which is the shell's "not found / not executable" rather
than a verification verdict. Most likely `python` is absent under that name on the runner, or the
downloaded script is not marked executable. **Not investigated** — the fix depends on which of those it
is, and guessing would replace one wrong answer with another.

Note this is the `EC-PRICE-1 / AT-M18.1` evidence, so it is a §12 acceptance test, not a nice-to-have.

## Open — `defender/test/filer.test.ts`, 5 failures, all in _"the posture gate: the source-scan half"_

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

## Open — `edge-case ledger is complete`

```
FAIL  19 case(s) have no referencing test and are not marked blocked
```

By design: this is WP-21's acceptance criterion and it is not met. See `docs/EDGE_CASES.md`.
