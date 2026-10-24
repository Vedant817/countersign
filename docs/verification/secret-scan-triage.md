# Secret-Scan Triage

## WP-14 follow-up — 2026-10-24 (IST)

The current Git-aware working-tree scan found two synthetic WP-14 test values. The history scan
reported the same values eight times across four T3 checkpoint commits; these were not new live
credentials. Tests now generate signing keys at runtime. Two new exceptions require both the
historical path and the exact dummy value, scoped through `targetRules` to `generic-api-key` or
`countersign-session-secret`. No new whole-file exclusion was added. An adversarial temporary
probe verified that the historical value is allowed only at its test path, while another value,
the historical value at another path, and a new SESSION_SECRET in either test path are detected.

The first probe showed that a global path exception skipped the entire file despite its value
condition. Assigning the exceptions to their specific rules kept file scanning active; the revised
probe passed. This follows the distinction between global and rule-targeted exceptions documented
in the [Gitleaks configuration reference](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md#configuration).

`.next/` was already ignored and is excluded by `scripts/secret-scan.mjs`'s Git file snapshot.
The earlier direct `gitleaks dir .` scan included ignored build output and was not equivalent to
`pnpm secret-scan`. The final command scans the current snapshot and Git history with redaction.
The pre-existing sixteen whole-file exclusions documented below remain a limitation.

---

**Date:** 2026-10-07

## Result

No real secrets found. The initial scan found 27 working-tree records and 1,955
historical records across 109 commits. These records reduce to 27 working-tree
path/rule/line findings and 34 historical path/rule/line identities; history repeats unchanged
findings across commits.

| Category                                 | Working tree | History |
| ---------------------------------------- | -----------: | ------: |
| Test fixtures and synthetic test vectors |           22 |   1,570 |
| Documentation examples                   |            5 |     385 |
| Lockfile noise                           |            0 |       0 |
| Commit-message text                      |            0 |       0 |
| Real secrets                             |            0 |       0 |

## Finding inventory

Counts are working-tree records / historical records.

| File                                                         | Rule                                   |  Counts |
| ------------------------------------------------------------ | -------------------------------------- | ------: |
| `.env.example`                                               | `countersign-database-url-credentials` |  1 / 77 |
| `.env.example`                                               | `countersign-session-secret`           |  1 / 77 |
| `.github/workflows/ci.yml`                                   | `countersign-database-url-credentials` | 2 / 154 |
| `.github/workflows/sandbox-nightly.yml`                      | `countersign-database-url-credentials` |  1 / 77 |
| `apps/vi/tests/test_l3.py`                                   | `generic-api-key`                      |  1 / 73 |
| `apps/web/app/status/status.test.ts`                         | `countersign-database-url-credentials` |  1 / 72 |
| `apps/web/app/status/status.test.ts`                         | `countersign-openai-api-key`           |  1 / 72 |
| `apps/web/app/status/status.test.ts`                         | `countersign-paypal-client-secret`     |  1 / 72 |
| `apps/worker/src/boot.test.ts`                               | `countersign-database-url-credentials` |   0 / 5 |
| `docker-compose.yml`                                         | `countersign-database-url-credentials` |  1 / 77 |
| `docs/verification/paypal-api-2026-10-04.md`                 | `curl-auth-header`                     |  1 / 77 |
| `packages/core/test/env.test.ts`                             | `countersign-database-url-credentials` |  1 / 75 |
| `packages/core/test/env.test.ts`                             | `countersign-vi-kek`                   |  1 / 75 |
| `packages/defender/test/evidence-doc.test.ts`                | `generic-api-key`                      | 2 / 154 |
| `packages/gate/src/decision-record.ts`                       | `private-key`                          |  1 / 77 |
| `packages/gate/test/fixtures/vi-binding-replay-capture.json` | `jwt`                                  | 4 / 212 |
| `packages/gate/test/fixtures/vi-verify-budget-capture.json`  | `jwt`                                  | 3 / 225 |
| `packages/paypal/src/idempotency.ts`                         | `generic-api-key`                      |  1 / 77 |
| `packages/verifier/test/fixtures/chain.json`                 | `jwt`                                  | 2 / 150 |
| `packages/vi-client/test/fixtures/README.md`                 | `countersign-vi-kek`                   |  1 / 77 |

The workflow and Compose database URLs are local CI/test configuration, the application test
matches are deliberate test vectors, and the PayPal ID in `idempotency.ts` is synthetic input for
the request-ID length measurement. Documentation matches are illustrative placeholders or a PEM
marker in a comment. The JWT findings are signed local-sandbox test captures. The committed captures
were explicitly checked for private JWK members `d`, `p`, `q`, `dp`, `dq`, `qi`, and `k`; all are
absent. PayPal-like credentials were also checked, with no live token or private key material
identified. Lockfiles produced no findings and are not excluded.

## Exact-path exceptions

The Gitleaks configuration now allowlists these exact paths:

- `.env.example`
- `.github/workflows/ci.yml`
- `.github/workflows/sandbox-nightly.yml`
- `apps/vi/tests/test_l3.py`
- `apps/web/app/status/status.test.ts`
- `apps/worker/src/boot.test.ts`
- `docker-compose.yml`
- `docs/verification/paypal-api-2026-10-04.md`
- `packages/core/test/env.test.ts`
- `packages/defender/test/evidence-doc.test.ts`
- `packages/gate/src/decision-record.ts`
- `packages/gate/test/fixtures/vi-binding-replay-capture.json`
- `packages/gate/test/fixtures/vi-verify-budget-capture.json`
- `packages/paypal/src/idempotency.ts`
- `packages/verifier/test/fixtures/chain.json`
- `packages/vi-client/test/fixtures/README.md`

These entries are deliberately file-scoped, not directory exclusions. However, a Gitleaks path
allowlist suppresses all rules throughout that file, so a future credential added to one of these
exact files would not be detected until the exception is reviewed. No baseline was added.

## Custom rule checks

The seven requested rule groups are implemented by eight rule IDs because VI private JWK and PEM
checks are separate:

| Rule group                           | Legitimate non-secret checked                     | Result     |
| ------------------------------------ | ------------------------------------------------- | ---------- |
| PayPal client secret                 | Public client identifier                          | No finding |
| OpenAI API key                       | Organization identifier and unset-key placeholder | No finding |
| `VI_KEK`                             | Unset-key placeholder                             | No finding |
| `SESSION_SECRET`                     | Unset-key placeholder                             | No finding |
| Credential-bearing `DATABASE_URL`    | Local URL without embedded credentials            | No finding |
| Gate private JWK                     | Public JWK containing public coordinates only     | No finding |
| VI private JWK / PEM near `VI_*_KID` | Public JWK and public certificate                 | No finding |

The Gate and VI JWK rules also check private JWK members `d`, `p`, `q`, `dp`, `dq`, `qi`, and `k`;
the PEM rule remains limited to private-key PEM markers. The legitimate-value check was performed
with temporary, non-secret examples outside the repository.

Each of the seven rule groups (eight rule IDs) also fired on its corresponding synthetic secret
vector. `pnpm secret-scan` exits 1 with an installation message when Gitleaks is missing; a planted
fake `SESSION_SECRET` was caught with exit 1. Gitleaks is not a project dependency; it was installed
via winget for verification.

## Final scan

`pnpm secret-scan` passes: 0 working-tree findings and 0 history findings. This is not a blanket
clean bill for every future change: the scan remains active outside the 16 exact allowlisted files,
but is quiet for all rules inside them. A credential later added to one of these files would evade
detection until its exception is reviewed. Review those paths before adding credentials or new
fixture data.
