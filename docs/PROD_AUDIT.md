# PROD AUDIT - what breaks when real users arrive

_Started 2026-11-13 (overnight, `prod/real-users`)._

Scope: make Countersign behave like a product if real users arrive tomorrow. No hardcoded values, no
stale data, no demo-only paths in production code, no dummy data, no fixtures outside
`packages/*/test/`. Where an external credential is genuinely missing, the app must **fail loudly with a
configured-off state** and never fake success.

Baseline measured on this branch, with real command output:

| Check                            | Result                                                              |
| -------------------------------- | ------------------------------------------------------------------- |
| `git status` at start            | clean `main`, 3 untracked paths (2 demo scripts, 1 screenshot dir)  |
| `git log -1 main`                | `eb05a31 chore: clear the lint errors main was carrying`            |
| `pnpm test`                      | **2862 passed, 10 skipped, 112 files passed / 2 skipped**           |
| `docker compose up -d --wait db` | `Container countersign-db Healthy`                                  |
| `pnpm db:migrate`                | `migrations applied successfully!`                                  |
| `pnpm db:seed`                   | 3 users, 1 device, 1 wallet, 24 products                            |
| `GET /status`                    | 503 - **correct**: PayPal is `not_configured` (no client id/secret) |
| `POST /api/agent/session`        | 200, real mandate `mdt_…` with real read-back                       |
| `POST /api/agent/run` (scripted) | ALLOW → real PayPal order `93826634BT458811M`                       |
| `GET /disputes`                  | 200, **reproduces `[object Object]`**                               |

Severity: **P0** = a user sees wrong output or loses data. **P1** = a real-user flow is impossible.
**P2** = correctness/robustness that will not be hit on day one but will be hit.

---

## 1. P0 — `[object Object]` on the dispute evidence page (**FIXED**)

**Where.** `apps/web/app/disputes/page.tsx:127-137` renders `citation.artefact` inside a `<span>`:

```tsx
<span className="font-mono">{citation.artefact}</span>
```

**What the type actually is.** `packages/defender/src/citation-check.ts:86` - `ClaimArtefact` is an
**object** `{ id, kind, description }`, not a string. `apps/web/lib/defender-demo.ts` flattened it with
`String(c.artefact)`, which is `String({...})` → `"[object Object]"`.

**Evidence (before).** Live render of `http://127.0.0.1:3000/disputes` contained 15 instances of
`<span class="font-mono">[object Object]</span>`, one per cited claim, on the packet the PDF publishes.
This is the page a PayPal adjudicator reads.

**Fix.** The view type now carries `artefact: { id, kind, description }`; `demoCases` maps the three
fields through; the page renders the §7.3 bundle id (`capture:…`, `gate:…`) with its description.

**Verified after.** `GET /disputes` → 200, `[object Object]` occurrences **0**, `capture:DEMO00000000000002`
rendered. `apps/web/lib/defender-demo.test.ts` asserts the shape and the absence of `[object Object]` in
the serialised view.

**Also found in the same render, fixed with it.** `amount` printed **`$$128.00`** — the value is now
`formatMoney(...)` alone, and the test asserts `/^\$[\d,]+\.\d{2}$/`.

---

## 2. P0 — garbled intent read-back in the agent chat (**FIXED**)

**Where.** `packages/agent/src/scripted.ts:108` and `packages/agent/src/agent.ts:135`:

```ts
text: `Reading your mandate. ${mandatory.readback.split('\n')[0] ?? ''}`.trim()
```

`readBack()`'s first line is the **markdown header** `**What you are authorising**`
(`packages/compiler/src/readback.ts:65`), not a limit. Every run opens with the literal sentence:

```
Reading your mandate. **What you are authorising**
```

**Evidence (before).** Captured from the SSE stream of `POST /api/agent/run` (real run, order
`93826634BT458811M`): `thought: {"text":"Reading your mandate. **What you are authorising**"}`.

Two more defects in the same two lines:

- `agent-chat.tsx` `firstLine()` stripped `**What` lines by `startsWith('**What')` — a hardcoded English
  prefix, so any other read-back wording renders as raw markdown in the mandate chip.
- `split('\n')[0]` means **the cap the buyer signed is never shown** in the transcript. The whole point
  of the chip is "what did I sign".

**Fix.** `packages/agent/src/readback-summary.ts` — a structural rule, not a textual one: a line that is
_entirely_ a bold span is a heading and is skipped; the first line that is not is content, and it comes
back with no markup, cut on a word boundary. Both loops use it. The session route returns
`readback_summary` and `cap_display` so the client renders one server-computed string instead of a second
implementation (`CENTS()` divided by 100 and prepended `$` — the same class of bug as `c6d6855`).

**Verified after.** `POST /api/agent/session` → `readback_summary: "Spend at most $50.00 in total"`,
`cap_display: "$50.00"`. SSE `POST /api/agent/run` →
`thought: "Reading your mandate. Spend at most $50.00 in total"`.
`packages/agent/test/readback-summary.test.ts` asserts the rule against a real `readBack()` output.

---

## 3. P0 — signing keys are ephemeral per process (no persistence, no rotation) (**FIXED**)

**Where (before).** `apps/vi/src/vi_service/keys.py` `KeyStore._boot()`:

```python
"""Mint the ISSUER and MERCHANT keys. Ephemeral by design (spec §3.1: 'in memory')."""
for role, kid in (("ISSUER", …), ("MERCHANT", …)):
    key = generate_es256_key()
```

**Consequence.** Every restart of `countersign-vi` minted a **new** issuer and merchant key under the same
`kid`. Evidence signed before the restart cannot be verified after it: `GET /v1/jwks` publishes a
_different_ public key under the _same_ `kid`, so a verifier resolves the kid, gets the new key, and the
old signature fails. There is no `RETIRED` state and no `kid` change, so EC-KEY-2/EC-KEY-3 (verify after
rotation) are structurally unreachable. `jwks_keys` in Postgres is a mirror that is refreshed per process
(`agent-session.ts::syncViKeys`) and therefore silently followed the restart.

`GATE_SIGNING_KEY` was worse: `scripts/dev-local.mjs` generated a **fresh Ed25519 key on every launch**,
so every Gate decision record ever signed became unverifiable when the dev server restarted.

**Fix.** vi stays stateless — no datastore — and the two network keys are now **derived deterministically
from `VI_KEK`** with HKDF-SHA256, one `info` label per role (`derive_signing_key`,
`keys.py`). `VI_KEK` is already this service's root of trust: agent private keys are encrypted under it,
and losing it already invalidates them. So:

- same KEK → same issuer/merchant key → the same `kid`→key pair in JWKS, across restarts and replicas;
- different KEK → a different key, provably (a zero KEK gives a different public key);
- the two roles never share a key (one label each);
- `AGENT` keys are still minted at random and are refused as a derivation role;
- a missing or malformed KEK is refused at boot with `CS_VALIDATION` instead of silently replaced by a
  random key — a random key under an existing `kid` is exactly the failure this replaced.

Rotation is unchanged and still the only way to get a new `kid` (`POST /v1/keys/rotate`).

The dev launcher now prefers an operator-configured `VI_KEK`, `VI_SERVICE_TOKEN`, `SESSION_SECRET` and
`GATE_SIGNING_KEY` from `.env.local` (`secretOr`) and only generates what is absent — and it **prints
which** were generated, because that is the case where a restart invalidates earlier evidence. Before
this, all four were overwritten with `randomBytes(...)` on every launch, so a developer who configured
them was silently ignored.

**Verified (real output).**

```
$ node vi-restart-probe.mjs <root>     # two real uvicorn processes, same KEK
run1: probe-issuer:ISSUER:Ei2JH_G45ELInLEh
      probe-merchant:MERCHANT:-I_h1tjv8UW87IW7
run2: probe-issuer:ISSUER:Ei2JH_G45ELInLEh
      probe-merchant:MERCHANT:-I_h1tjv8UW87IW7
identical: true
```

`apps/vi` tests: `212 passed`, including five new ones (issuer and merchant identical across
`reset_keystore()`, a different KEK gives a different key, the two roles never share a key, `AGENT` is
refused as a derivation role). `pnpm vi:lint` → `All checks passed!`.

---

## 4. P1 - there is no real buyer account, so nothing can be captured

**Where.** `apps/web/lib/agent-session.ts` provisions a **new user per request**
(`newId('usr')`, `demo.buyer.<id>@example.test`), with `payment_token_id: DEMO-NOT-A-VAULT-TOKEN-…`.

**Consequence.** No session, no login, no user-owned data, no wallet, no history. `/api/agent/session`
mints a fresh identity every call and `agentDemoAllowed()` gates the whole surface behind
`COUNTERSIGN_AGENT_DEMO=1` + non-production, so on a real deployment **the agent chat does not exist**.
Per-user data isolation (priority 3 in the brief) has no foundation: `users` rows are per-request
throwaways, and there is no cookie, no session, no ownership check anywhere in `apps/web`.

`iron-session` + `SESSION_SECRET` are validated at boot but **never used**: `grep -r iron-session` finds no
call site. There is no `/api/auth`, no login page, no `middleware.ts`.

**Blocked on** HUMAN_TODO 1a (Vault + buyer credentials). The code path that needs it is
`packages/orders/src/create.ts:305` `payment_source: { paypal: { vault_id: draft.wallet.vaultId } }` —
complete and tested, unreachable because no wallet ever holds a real `vault_id`.

---

## 5. P1 - PayPal: order create/get work; authorize, capture, refund, void, disputes still unreachable (webhooks **DONE**)

Verified live in this session: `createDemoOrder` (no payment source) → real sandbox order; `rereadDemoOrder`
→ `GET /v2/checkout/orders/{id}` answers.

Not reachable from the app:

| Capability                         | Library                                               | App call site                                                     |
| ---------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| authorize / capture                | `packages/paypal` `authorizeOrder`, `captureOrder` ✅ | none                                                              |
| refund / void                      | `refundCapture`, `voidAuthorization` ✅               | none                                                              |
| webhooks (verify + ingest)         | `packages/webhooks` ✅ + `apps/worker` ✅             | **`apps/web/app/api/webhooks/paypal/route.ts` — DONE 2026-11-13** |
| disputes ingest / provide-evidence | `listDisputes`, `getDispute`, `provideEvidence` ✅    | none - `/disputes` renders fixtures                               |
| reconciler crons                   | `apps/worker/src/schedule.ts` ✅                      | `render.yaml` defines the worker; never run here                  |

**Webhook ingest (fixed 2026-11-13).** `POST /api/webhooks/paypal` now stores PayPal's exact bytes, verifies
through `PayPalClient`, marks the row `PENDING`/`VERIFIED`/`FAILED`, and acknowledges per §8.12 (200 for
stored, 400 for a forged or unreadable body). The producer queue is deliberately not wired to `pg-boss` in the
web process (the worker owns it); a stored delivery is deferred to `wh.verify` and the reconciler's sweep rather
than lost. `PAYPAL_WEBHOOK_ID` is still empty, so verification runs the EC-WH-7 configured-off path until
HUMAN_TODO 2/3 lands; the positive case is asserted in `packages/webhooks` against the real client. The
Postgres-backed adapter suite (`apps/web/app/api/webhooks/paypal/route.test.ts`, 6 tests) covers byte-exactness,
the forged/unreadable 400, the redelivery invariant, and header canonicalisation.

## **Still blocked on** HUMAN_TODO 1a/2/3 for the buyer-side half (authorize → capture → refund/void, disputes).

## 6. P1 - the demo money path reads `.env.local` from disk behind the app's own config (**FIXED**)

**Where (before).** `apps/web/lib/demo-order.ts::paypalCreds()` — when `process.env.PAYPAL_CLIENT_ID` was
empty it walked `cwd`, `../../`, `../../../` looking for `.env.local` and parsed it with a regex.

**Why it was wrong for production.** `docs/` and `.env.example` both say secrets come from env vars only
(AGENTS.md rule 4, spec §6). A file-reading fallback means a container with a mounted `.env.local` would
silently use credentials the operator did not put in the environment, and a failed read was swallowed by
`catch {}`. It also meant `/status` and the order path could disagree about whether PayPal is configured —
the exact class of "two sources of truth" this repo documents as a bug class (D-040).

**Fix.** `paypalCreds()` now reads the environment and nothing else; there is no `fs` or `path` import left
in the module, so the behaviour cannot come back by accident. `scripts/dev-local.mjs` remains the single
thing that turns `.env.local` into the environment, for the whole process rather than for one code path.

**A second instance of the same defect, found while fixing this one.** `PAYPAL_API_BASE` had _two_
resolutions: `demo-order.ts` defaulted an unset value to `https://api-m.sandbox.paypal.com`, while
`status/route.ts` treated an unset `PAYPAL_API_BASE` as "PayPal is not configured" and answered
`paypalConfigured: false` (a 503). So the money path could create a real sandbox order on a deployment
whose own health page said PayPal was absent. Both now call `lib/paypal-base.ts`
(`resolvePaypalBase` / `isAllowedPaypalBase` / `DEFAULT_PAYPAL_BASE`), which is the one answer; the status
report also carries the resolved **host** (`paypalApiBaseHost`) so a reader can see that the app default is
in use rather than having to guess from a boolean. A live host is still refused by `assertSandbox` in
`PayPalClient`, so the default cannot become a route to real money.

**Verified (real output).**

```
$ pnpm --filter @countersign/web test
 Test Files  14 passed (14)
      Tests  152 passed | 1 skipped (153)

$ pnpm vitest --run apps/web/lib/paypal-base.test.ts
 ✓ |web| lib/paypal-base.test.ts (7 tests) 5ms
      Tests  7 passed (7)

$ pnpm --filter @countersign/web typecheck
$ tsc --noEmit        # no errors
```

`pnpm lint` → 0 errors, 8 pre-existing warnings, `money-discipline: clean`. `pnpm format:check` → clean.

**Live credential check (no secret printed).** The sandbox client id/secret in `.env.local` were exercised
against `POST /v1/oauth2/token` with HTTP Basic: `oauth ok, token len 97`. The `Authorization: Bearer`
form a first attempt used was refused `401 invalid_client` — worth recording because `PayPalClient` uses
Basic, so the working form is the one the app already uses.

---

## 7. P1 - `/status` is the only health surface, and the worker has none

`render.yaml` gives `web` `healthCheckPath: /status`, and `countersign-vi` is `internal: true` with no
health check. `countersign-worker` has no health check either (correct for a worker, but then nothing
detects a dead reconciler). `/status` reads Postgres, vi, PayPal, MCP and the model, which is good — but it
cannot tell a reader that the **reconciler has never run**, which is the failure that loses a dispute
deadline.

---

## 8. P2 - correctness and robustness

| #    | Finding                                                                                                                                                                                                       | Evidence                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 8.1  | `$$128.00` on `/disputes` (double currency symbol)                                                                                                                                                            | live render                                             |
| 8.2  | `defender-demo.ts` caches rendered cases in a module `Map` forever, keyed by case id, with `nowSec` baked in — a long-running process shows a **stale** `response due` date and a stale hash                  | `const cache = new Map<DefenderCaseId, RenderedCase>()` |
| 8.3  | `demoVerifierRows` awaits a **render** from a GET handler and `jwks.listAll()` returns `[]`, so a scanned QR reports chain checks as SKIPPED forever                                                          | `demo-verifier.tsx:78`                                  |
| 8.4  | `agent-chat.tsx` sends `mode: 'scripted'` from both chat buttons, so the LLM path is unreachable from the UI even when a model is configured                                                                  | `agent-chat.tsx:271,290`                                |
| 8.5  | ~~`agent-chat.tsx` `CENTS()` re-implements money formatting~~ **FIXED 2026-11-13** — the client now calls `formatMoney` from `@countersign/core` with the Gate's own minor units and currency (`amountLabel`) | `agent-chat.tsx`                                        |
| 8.6  | `defender-demo.ts` is `server-only` but imports `ai` and calls the model at request time with no timeout; a hung provider hangs the page                                                                      | `renderDefenderCase`                                    |
| 8.7  | `apps/web/app/api/agent/run` builds an MCP HTTP client **pointing at itself** (`/api/mcp/http`) while the route is `/api/mcp/[transport]` — it works only because `[transport]` matches `http`                | `route.ts:110`                                          |
| 8.8  | `demo-order.ts` `toDemoOrder` casts `raw as {...}` and reads `custom_id` from two places with different shapes                                                                                                | —                                                       |
| 8.9  | `packages/webhooks/src/*.d.ts` files exist in the tree (untracked build emit, ignored by `.gitignore` `*.d.ts`) — harmless, but `packages/webhooks` has no `dist`                                             | `git ls-files` shows none                               |
| 8.10 | `render.yaml` still pins `LLM_MAIN_MODEL: gpt-6.1-sol` / `gpt-6-luna` — illustrative spec names, not real model ids (docs/DECISIONS.md already removed this default from `env.ts`)                            | `render.yaml`                                           |
| 8.11 | `render.yaml` `GATE_SIGNING_KEY` comment says "P-256 private JWK"; the code requires **Ed25519**                                                                                                              | `render.yaml` vs `gate-runtime.ts`                      |
| 8.12 | No CI job runs the Python tests on Linux in the same workflow as the JS gates (`sandbox-nightly.yml` is separate and needs secrets)                                                                           | `.github/workflows/ci.yml`                              |
| 8.13 | `docs/EDGE_CASES.md`: 62 done / 42 wip / 3 blocked / 2 dropped of 109                                                                                                                                         | `pnpm test:ec`                                          |

---

## 9. Explicitly checked and **not** a problem

- **`[object Object]` from error handling** — `DECISIONS.md:803` records the fix; `gate-runtime.ts`,
  `apps/worker/src/index.ts` and `agent-session.ts` all now unwrap `CsError` before stringifying.
- **`packages/gate` importing `ai`** — ESLint rule present, no violations (`pnpm lint` passes on main).
- **`countersign.vercel.app`** — not referenced anywhere in the tree.
- **Fixtures in production code** — `packages/paypal/test/fixtures/` is the only fixture directory and is
  outside `src/`.
- **Float money** — `scripts/check-money-discipline.mjs` passes.

---

## 10. Order of work (this branch)

1. **[P0]** `[object Object]` on `/disputes` + the `$$` double symbol. ✅ **done 2026-11-13** (§1)
2. **[P0]** garbled read-back in the agent chat + show the real cap + kill `firstLine`'s hardcoded prefix.
   ✅ **done 2026-11-13** (§2)
3. **[P0]** persistent issuer/merchant/Gate signing keys; refuse to boot on an unusable key. ✅ **done
   2026-11-13** (§3 — derived from `VI_KEK`, two real processes compared)
4. **[P1]** fail-loudly configuration audit: delete the `.env.local` disk fallback. ✅ **done 2026-11-13**
   (§6 — env-only credentials, and one shared `PAYPAL_API_BASE` resolution for `/status` and the order
   path).
5. **[P1]** real webhook ingest route with PayPal signature verification (unblocked; needs
   `PAYPAL_WEBHOOK_ID` only for the positive case, and must refuse loudly without it).
6. **[P1]** real buyer accounts + per-user isolation (blocked on Vault for the money half; the account
   half is buildable now).
7. **[P1]** PayPal authorize → capture → refund → void wired to the app, each verified against the
   sandbox by command output in this thread.
8. **[P1]** Disputes API ingest + provide-evidence wired to the app, replacing the fixture page.
9. **[P1]** LLM path configurable, with graceful configured-off behaviour everywhere.
10. **[P1]** edge cases: every §12 row, including PayPal 5xx/timeouts, duplicate webhooks, concurrent
    checkouts on one budget, revoked mandate mid-checkout, refund after chargeback, tampered packets,
    prompt injection.
11. **[P1]** CI green: lint, typecheck, test, Python tests, Playwright e2e.
12. **[P2]** deploy readiness: Dockerfiles, Render config, health checks, migrations.
