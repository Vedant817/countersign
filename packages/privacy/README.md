# `@countersign/privacy` — M19

Privacy, retention, erasure and observability for Countersign. Spec §8.19 (contract) and §12.13
(retention table); work package **WP-19**.

**Tests: 41**, all offline. `pnpm --filter @countersign/privacy test`.

## Why this package exists

Three separate promises in the spec need code rather than prose:

1. **§12.13's retention table** is a set of windows (540 days for mandates and evidence, 365 for
   operational logs, 30 for LLM prompts, 90 for webhook payloads) with different lawful bases. A
   nightly sweep that re-implements them from memory will disagree with the privacy page within a
   week, so the table is data here and both the page and the sweep read it.
2. **Erasure is not a `DELETE`.** §12.13 asks for pseudonymisation with the crypto hashes kept,
   because the mandates, gate decisions and evidence packets referencing the user are under a
   separate legal-claims basis and must stay verifiable. Deleting the row breaks the audit chain;
   keeping the email makes the erasure a lie. `pseudonymiseUser` is the middle path.
3. **A legal hold has two shapes.** An open dispute is an obligation whose end is unknown; the
   540-day evidence window is an interval whose end is arithmetic. They warrant different answers,
   and AT-M19.1 ("blocked by a legal hold, then allowed after resolution") is only satisfied honestly
   if resolution releases the first and not the second.

## What is here

| Module            | Question it answers                                                                   |
| ----------------- | ------------------------------------------------------------------------------------- |
| `policy.ts`       | How long may we keep this? `RETENTION_POLICY`, `retentionDeadline`, `withinRetention` |
| `hold.ts`         | May this be erased today, and what is the subject told? `planErasure`                 |
| `pseudonymise.ts` | What does "erased" mean for a row? `pseudonymiseUser`, `piiDigest`                    |
| `sweep.ts`        | What would a purge delete? `planSweep` — a plan, never a delete                       |
| `notice.ts`       | The 48-hour pre-erasure notice (EC-PRIV-5)                                            |
| `export.ts`       | The subject-access bundle (EC-PRIV-2)                                                 |
| `status.ts`       | Is anything stuck? `webhookHealth`, `overallStatus` (§8.19 `/status`, §14 SLOs)       |
| `disclosure.ts`   | What may reach a model, and where does the data go? (EC-PRIV-4, EC-PRIV-6)            |

Everything is a pure function or a port. There is no database client, no PayPal call and no
environment read beyond `PRIVACY_PSEUDONYM_SALT` — deliberately, so the acceptance tests run without
credentials and the composition root stays in `apps/web`, where the environment is validated.

## Acceptance

**AT-M19.1 — erasure blocked by a legal hold, then allowed.** `test/retention.test.ts` covers the
full path: a dispute holds erasure and names itself; resolution **releases the dispute hold but not
the window**, so the request stays held with a final date; once the window closes the request
proceeds, subject only to the 48-hour notice floor; and a subject who never bought anything is
released immediately.

**AT-M19.2 — logs contain no email or full name.** The logger itself is `@countersign/core`'s
`createLogger` (two filters: key-name redaction from `PII_KEYS`, and value-shape scrubbing for
emails, cards and phones), so its regex test lives in `packages/core/test/env.test.ts`. This package
asserts the other half — that an **export** cannot leak a second person's address out of a free-text
dispute note, and that `redactFreeText` removes a known name that no pattern could find.

## Honest limits

- **A name inside a free-text message is not detectable.** The rule is "put names in a named field",
  and `PII_KEYS` is what makes that rule enforceable. `redactFreeText` removes names only when the
  caller supplies them. Claiming otherwise would be a false assurance, so the code says so instead.
- **The pseudonym salt is only as good as its configuration.** With no `PRIVACY_PSEUDONYM_SALT`, the
  digest is a bare `sha256(email)`, which is brute-forceable against a candidate list.
  `pseudonymSaltConfigured()` exists so a caller can refuse; this package does not, because
  configuration belongs to the composition root.
- **Nothing here purges anything.** `planSweep` decides what a purge _would_ delete and refuses to
  plan one from a clock before the project existed — but the worker job that calls it with real rows
  and executes the deletes is not written yet.
- **§12.13's export is delivered as a value, not a zip.** Turning `ExportBundle` into bytes and a
  download is the delivery layer's job.
- **No PayPal call is made.** §12.13 says erasure "delete[s] the vault token at PayPal";
  `pseudonymiseUser` returns that as a required external action (`ExternalErasureAction`) so a caller
  cannot silently skip it, but the call itself is `@countersign/paypal`'s.

## Related

- Spec §8.19 (module contract), §12.13 (retention table and EC-PRIV-1…6), §14 (SLOs).
- `docs/contract-issues.md` for the composition gaps this package leaves to its caller.
