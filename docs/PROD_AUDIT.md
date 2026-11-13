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

## 4. P1 - there is no real buyer account, so nothing can be captured (**identity half FIXED 2026-11-13**)

**Where.** `apps/web/lib/agent-session.ts` provisioned a **new user per request** (`newId('usr')`,
`demo.buyer.<id>@example.test`), with `payment_token_id: DEMO-NOT-A-VAULT-TOKEN-…`.

**Consequence.** No session, no user-owned data, no history: `/api/agent/session` minted a fresh identity every
call, so two turns in one browser were two strangers and a reload was a third. `iron-session` and
`SESSION_SECRET` were validated at boot and never read.

**Fixed 2026-11-13 (identity).** `apps/web/lib/session.ts` owns the cookie (`cs_session`, `SESSION_SECRET`
refused below 32 characters, `httpOnly`, `sameSite: 'lax'`, `Secure` in production, 7-day ttl). It carries the
user id **and nothing else** — every other fact is re-read from `users`, so revoking a row takes effect on the next
request instead of at cookie expiry. `/api/agent/session` reads the cookie, passes it to
`provisionAgentSession({ userId })`, and calls `rememberUser`; `/api/agent/run` refuses a body that names another
browser's buyer **before the mandate is read** (`guardRunUser` → 403).

A returning browser keeps its user row and its wallet row — `paypal_wallets_payment_token_id_key` is UNIQUE and
the demo's placeholder token is derived from the user id, so a second insert is a unique violation rather than a
second instrument. The mandate, the device key and the agent key stay **per call**: `demo-device.ts` mints a fresh
P-256 key each time and never persists the private half, so a stored device row could not sign a second L2, and
`l1_credentials` is UNIQUE (device_id, wallet_id) — a new device beside the reused wallet is exactly the row that
constraint expects.

**Verified:** `apps/web/lib/session.test.ts` (11 tests: round-trip, forged cookie is anonymous rather than an
error, missing/short secret refuses, forget, cookie flags, the run-user rule); `apps/web/tests/e2e/session.spec.ts`
(3 browser tests: one browser keeps one buyer across two mandates, two browsers are two buyers, a run cannot claim
another browser's buyer). **Falsified three ways:** dropping the 32-character floor fails the secret test; removing
`guardRunUser` from the run route turns the third e2e test's 403 into a 200; creating a second wallet for a
returning buyer fails the first e2e test on `paypal_wallets_payment_token_id_key`.

**Still blocked on** HUMAN_TODO 1a (Vault + buyer credentials) for the money half. The code path that needs it is
`packages/orders/src/create.ts:305` `payment_source: { paypal: { vault_id: draft.wallet.vaultId } }` — complete and
tested, unreachable because no wallet ever holds a real `vault_id`. `agentDemoAllowed()` still gates the whole
surface behind `COUNTERSIGN_AGENT_DEMO=1` plus a non-production `NODE_ENV`, so a deployed application does not
serve demo identities; a real login is what replaces that gate when real accounts land.

---

## 5. P1 - PayPal: order create/get work; authorize, capture, refund, void, disputes still unreachable (webhooks **DONE**)

Verified live in this session: `createDemoOrder` (no payment source) → real sandbox order; `rereadDemoOrder`
→ `GET /v2/checkout/orders/{id}` answers.

Not reachable from the app:

| Capability                         | Library                                               | App call site                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| authorize / capture                | `packages/paypal` `authorizeOrder`, `captureOrder` ✅ | none                                                                                                                                                                        |
| refund / void                      | `refundCapture`, `voidAuthorization` ✅               | none                                                                                                                                                                        |
| webhooks (verify + ingest)         | `packages/webhooks` ✅ + `apps/worker` ✅             | **`apps/web/app/api/webhooks/paypal/route.ts` — DONE 2026-11-13**                                                                                                           |
| disputes ingest / provide-evidence | `listDisputes`, `getDispute`, `provideEvidence` ✅    | **`/disputes` reads real rows + `wh.disputes` assesses (item 8); the §8.15 click exists (`/disputes/[id]`, S-17), but a live `provideEvidence` still needs a real dispute** |
| reconciler crons                   | `apps/worker/src/schedule.ts` ✅                      | `render.yaml` defines the worker; never run here                                                                                                                            |

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

## 7. P1 - `/status` is the only health surface, and the worker has none (**FIXED 2026-11-13**)

Three separate gaps, three separate fixes.

**(a) The worker had no liveness signal at all.** `countersign-worker` is `type: worker`: no port, no
health check, and nothing to notice that it died. The symptom would have been invisible — the web process
keeps acknowledging webhooks (§8.12 step 5), so a dead reconciler looks like a quiet week until a dispute
deadline is missed. The worker now writes **one row per finished job run** to `worker_job_runs`
(`packages/db/src/schema.ts`, migration `0004`, pruned on write to seven days):
`worker_id`, `job`, `outcome`, `started_at`, `finished_at`, `duration_ms`, `error_code`. The write is
applied by `withHeartbeats` (`apps/worker/src/heartbeat.ts`) around the whole handler table, so it covers
`wh.process` and every cron, and it records the **throw** — a handler that throws is the retryable case a
"last run" column would miss. A failed heartbeat write never fails the job.

**(b) `/status` could not say whether the reconciler had ever run.** It now has a `worker` section
(`buildWorkerSection` in `apps/web/app/status/probe.ts`) that reads those rows and judges each job with
`jobHealth`/`workerHealth` from `@countersign/privacy`. The states are `ok | lagging | stalled | failing |
never`, and they are deliberately different: a job that is **punctual and failing** is `failing` (a cron
that throws every five minutes is not "behind", it is broken), a job with no row is `never`, and a worker
whose _every_ job is `never` is reported as "not running" rather than as a quiet system. Thresholds are
`max(§14's 300 s, the job's own cadence)` — a nightly job is not judged against five minutes, or the page
would be red for 23 hours a day and nobody would believe it. The cadence table lives in
`@countersign/privacy` because `apps/web` must not import the worker's module graph; a worker test asserts
the copy and `apps/worker/src/schedule.ts` agree, so a changed cron fails in the package that owns it.

**(c) Two services had no health check they could have had.** `countersign-vi` gains
`healthCheckPath: /v1/status` — it is `internal: true`, but Render health-checks an internal service over
the private network, which is exactly where the Gate calls it. `countersign-worker` gains an **opt-in**
`GET /health` (`apps/worker/src/health.ts`, bound to loopback, on only when `WORKER_HEALTH_PORT` is set)
for an operator or an external monitor. It is opt-in because a listener nobody asked for is a liability; the
primary signal remains the heartbeat table.

The worker section **cannot** fail `/status`: a dead reconciler is a serious operational fault and not an
outage of anything a buyer is asking for, and pulling the web instance out of rotation would take the
storefront down with it and repair nothing.

Verified by: `packages/db/test/repos.worker.live.test.ts` (6 tests against a real Postgres — including
`max(...) FILTER`, the retention delete and the caller's transaction), `packages/privacy/test/job-health.test.ts`
(14), `apps/worker/test/heartbeat.test.ts` (7), `apps/worker/test/health.test.ts` (7, over a real socket),
`apps/web/app/status/worker-section.test.ts` (8).

---

## 8. P2 - correctness and robustness

| #    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 8.1  | `$$128.00` on `/disputes` (double currency symbol)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | live render                                                                                             |
| 8.2  | ~~`defender-demo.ts` caches rendered cases in a module `Map` forever, keyed by case id, with `nowSec` baked in - a long-running process shows a **stale** `response due` date and a stale hash~~ **FIXED 2026-11-13** - the cache is now an entry `{ atSec, rendered }` with a one-hour TTL (`CACHE_TTL_SEC`), the clock is read _before_ the freshness check, and one render per case is shared in flight, so a page and a QR scan cannot double-run the pipeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `defender-demo.ts` (`cachedCase`, `renderDefenderCase`)                                                 |
| 8.3  | ~~`demoVerifierRows` awaits a **render** from a GET handler and `jwks.listAll()` returns `[]`, so a scanned QR reports chain checks as SKIPPED forever~~ **FIXED 2026-11-13** — two real defects behind the symptom: (a) the render was cached by case id alone while the origin is baked into the PDF's QR payload, so a cold process served one host's packet to another and `demoVerifierRows` read `PUBLIC_BASE_URL ?? localhost:3000` instead of the caller's origin — the cache is now keyed by (case, origin) and the verifier page passes its own request origin; (b) `bundle_hash` was recomputed from the same object it was compared against, so the row could never fail — the digest is now captured at render time and stored on the row. The nine permanent SKIPPED gate-signature rows are reported as a count and a reason instead of nine grey verdicts. Tests falsify both (a) and (b)                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/web/lib/defender-demo.ts`, `apps/web/app/v/[packetId]/demo-verifier.tsx`                          |
| 8.4  | ~~`agent-chat.tsx` sends `mode: 'scripted'` from both chat buttons~~ **FIXED 2026-11-13** — the free-form turn and the "buy inside the limit" button now use a Model/Scripted planner toggle (default **Model**); the run route already falls back to scripted and says so when no key is configured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `agent-chat.tsx` (planner toggle)                                                                       |
| 8.5  | ~~`agent-chat.tsx` `CENTS()` re-implements money formatting~~ **FIXED 2026-11-13** — the client now calls `formatMoney` from `@countersign/core` with the Gate's own minor units and currency (`amountLabel`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `agent-chat.tsx`                                                                                        |
| 8.6  | ~~`defender-demo.ts` is `server-only` but imports `ai` and calls the model at request time with no timeout; a hung provider hangs the page~~ **FIXED 2026-11-13** - the adapter (`defenderDraftPort`) passes `abortSignal: AbortSignal.timeout(15_000)` per attempt; `draft()` already turns any port error into `LLM_UNAVAILABLE` and falls back to the deterministic template. A test drives a model that never answers and asserts the promise settles in < 2 s, and was confirmed to time out when the signal was removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `defender-demo.ts` (`defenderDraftPort`, `DEFENDER_DRAFT_TIMEOUT_MS`)                                   |
| 8.7  | ~~`apps/web/app/api/agent/run` builds an MCP HTTP client pointing at itself (`/api/mcp/http`) while the route is `/api/mcp/[transport]` — it works only because `[transport]` matches `http`~~ **FIXED 2026-11-13**: `app/api/mcp/[transport]/endpoint.ts` owns `MERCHANT_MCP_PATH` + `merchantMcpUrl(origin)`, the agent route consumes it, and `endpoint.test.ts` fails if either route re-introduces the literal. The HTTP self-call stays and is documented as the honest coupling (the agent package consumes an MCP client; the alternative is duplicating the tool runtime)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/web/app/api/mcp/[transport]/endpoint.ts`                                                          |
| 8.8  | ~~`demo-order.ts` `toDemoOrder` casts `raw as {...}`~~ **FIXED 2026-11-13** - it now takes the `Order` type `createOrder`/`getOrder` already return, so `purchase_units[0].custom_id` and `amount.value` are compiler-checked reads; the cast was also reading a top-level `custom_id` that is not part of `Order`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `apps/web/lib/demo-order.ts` (`toDemoOrder`)                                                            |
| 8.9  | ~~`packages/webhooks/src/*.d.ts` files exist in the tree (untracked build emit) — harmless, but `packages/webhooks` has no `dist`~~ **CORRECTED 2026-11-13** — neither half holds: `src/` contains only the nine `.ts` sources (no emit), and `dist/` holds the sixteen declaration files the package's `build` produces. `pnpm --filter @countersign/webhooks build` exits 0, `dist/` is ignored build output, and nothing imports it: `package.json` points `main`/`types`/`exports` at `./src/index.ts`, because every package in this repo is consumed as TypeScript source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `packages/webhooks/{package.json,tsconfig.build.json}`                                                  |
| 8.10 | ~~`render.yaml` pins `LLM_MAIN_MODEL: gpt-6.1-sol` / `gpt-6-luna`~~ **FIXED 2026-11-13** — both are now `sync: false` (a real id for the configured provider), with `OPENAI_BASE_URL` and the Modal proxy pair declared; the worker declares no LLM vars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `render.yaml`                                                                                           |
| 8.11 | ~~`render.yaml` `GATE_SIGNING_KEY` comment says "P-256 private JWK"~~ **FIXED 2026-11-13** — the comment now says Ed25519 private key (base64 32 bytes), matching `gate-runtime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `render.yaml`                                                                                           |
| 8.12 | ~~No CI job runs the Python tests on Linux~~ **CORRECTED 2026-11-13**: `test-python` has always run them. The real gap was Playwright, now closed - `test-e2e` runs the browser suite on `ubuntu-latest` and is required by `all-gates-green`. CI run 43315696870 is **green on all 11 jobs** (e2e 16 passed in 38.2 s; gitleaks 8.30.1, 199 commits, no leaks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `.github/workflows/ci.yml`                                                                              |
| 8.14 | ~~The agent chat keyed Gate reasons by `CsError.code` alone~~ **FIXED 2026-11-13** - the Gate emits one reason per failed check and two can share a code, so React de-duplicated them and dropped a reason (console: "Encountered two children with the same key, `CS_INTERNAL`"). Both lists now key on code + position                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `agent-chat.tsx` (`TurnView`, limits-held panel)                                                        |
| 8.13 | ~~`docs/EDGE_CASES.md`: 62 done / 42 wip / 3 blocked / 2 dropped of 109~~ **CLOSED 2026-11-13**: every `wip` row was re-decided from the source. 27 were already implemented and tested but never marked `done` (the note still said "is WP-12" for code that had shipped), 1 is `blocked` on H-3, and 14 stay `wip` with the exact missing surface named - `revokeMandate` / `markWalletDeleted` / `markDeviceLost` / `rotateAgentKey` have no production caller, the stock decrement at ORDER_CREATED is unwired, and no receipt renderer exists. Now **89 done / 14 wip / 4 blocked / 2 dropped**. `status` semantics are stated in the ledger `$comment` so "done" cannot mean "someone wrote a test that mentions the id"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `pnpm test:ec`                                                                                          |
| 8.15 | ~~`.github/workflows/sandbox-nightly.yml` invokes `pnpm judge` and `pnpm --filter @countersign/evals eval:all`, neither of which exists, and copies `reports/eval-report.json` / reads `reports/evals/injection.json` that nothing wrote~~ **FIXED 2026-11-13** — the nightly could only ever fail, so its published SLOs were unverifiable claims. Added `packages/evals/src/nightly.ts` (`eval:nightly`), an **offline** runner (no model, no network — the same deterministic `compileOffline` path the P0-7 gate uses) that writes `report.json` (§14 compiler score) and `injection.json` (`gate_bypass_rate` = breach fraction; an empty corpus is a full breach, never a clean 0), fails non-zero below the 98% floor or on any breach, and resolves a relative `--out` against the git root (pnpm runs package scripts with cwd = the package dir). Added `scripts/summarise-evals.mjs` (the workflow's human-line summariser, which was also missing). The workflow's judge step and injection job now run `eval:nightly`, and the dead `scenario` dispatch input is gone. Proven end to end: `167/167 (100%)` compiler, `0/50` breaches, `gate_bypass_rate=0`, `node -e` assertion reads the written file. 4 new tests. EC-ENV-3's "scripts/sandbox-bootstrap.ts does not exist" is separately true and remains a deploy-time item | `packages/evals/src/nightly.ts`, `scripts/summarise-evals.mjs`, `.github/workflows/sandbox-nightly.yml` |

---

## 9. Explicitly checked and **not** a problem

- **`[object Object]` from error handling** — `DECISIONS.md:803` records the fix; `gate-runtime.ts`,
  `apps/worker/src/index.ts` and `agent-session.ts` all now unwrap `CsError` before stringifying.
- **`packages/gate` importing `ai`** — ESLint rule present, no violations (`pnpm lint` passes on main).
- **`countersign.vercel.app`** — not referenced anywhere in the tree.
- **Fixtures in production code** — `packages/paypal/test/fixtures/` is the only fixture directory and is
  outside `src/`.
- **Float money** — `scripts/check-money-discipline.mjs` passes.
- **Fresh demo/stub/hardcoded pass, 2026-11-13** — `TODO|FIXME|HACK|not implemented|unimplemented|coming
soon|lorem|placeholder|dummy` over all non-test `apps/`, `packages/`, `scripts/` sources: zero hits in
  production code paths (the only matches are tests, doc comments explaining decisions, and HTML input
  placeholders). The one apparent gap — `WebhookStore.events.findById` "not implemented in
  `@countersign/db`" in the web route — is honest and production-safe: the route's process never calls it
  (every lookup there is by `paypal_event_id`), while `apps/worker`'s store serves the same member
  through the package's parameterised `readRows` escape hatch, so `wh.process` (`jobs.ts:195`) works.
  All eight API routes were re-read: each validates the wire shape and maps `CsError` to a real status
  and message (`toBody`), and the SSE writer closes a failed stream with an error frame instead of
  hanging.

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
   ✅ **page half done 2026-11-13** — `/disputes` no longer renders fixtures on the path a merchant takes: it
   reads `disputes` through `listDisputesForReview` and shows the **stored** verdict (`liability`,
   `router_trace.ruleId`) with an explicit "not assessed yet" when the router has not run. The fixtures moved
   behind `COUNTERSIGN_AGENT_DEMO=1` **and** `NODE_ENV !== 'production'`, so `next start` cannot serve them.
   ✅ **defend step done 2026-11-13** — `wh.disputes` runs `orchestrator.ingestAndDefend` after its sweep
   (`apps/worker/src/defend.ts` + `defender-store.ts`, commit `0bf0c33`), bounded at 10 candidates per tick
   over `findDisputesNeedingAssessment`. It passes **no approval option**, so the filer's §8.15 gate exits
   with `awaitingApproval: true` and zero PayPal calls for every posture — the verdict, rule and posture are
   recorded in `disputes.liability` / `router_trace`, which is exactly what the page above renders. A real
   dispute is now assessed within two minutes of the sweep storing it.
   ✅ **approval surface done 2026-11-13 (S-17)** — `/disputes/[id]` shows the stored verdict, rule, facts,
   rationale, deadline, evidence and packet; `POST /api/disputes/[id]/decision` runs the real filer on
   approve (`renderPdf`/`provideEvidence` for CONTEST, `orders.defenderRefundsFromOrders` for REFUND) and
   records only an `audit_log` row on decline. Every action is audited in a per-case hash chain; a second
   click is refused without a PayPal call; the buyer on the order cannot approve; a real PayPal 404 reaches
   the merchant as 404. Covered by 45 unit/route tests (`dispute-approval`, `same-origin`, `decision/route`).
   **Caveat:** there is still no merchant sign-in — the route authorises on the existing `cs_session` cookie,
   which today only `/api/agent/session` mints as a _buyer_ persona. A real deployment needs a merchant login
   before a merchant can click (item 6).
   **Still open:** only a **real dispute** (HUMAN_TODO 1a/2: a captured payment and the Disputes
   product/simulator) stands between this and a real filed packet; `provideEvidence` on an absent id still
   returns PayPal's own 404, never a fabricated success.
   **Live probe, 2026-11-13 (`scripts/paypal-dispute-probe.mts`, real sandbox through our own client):**
   `getDispute` on an absent id → PayPal 404 `RESOURCE_NOT_FOUND` → our `PP_NOT_FOUND` (debug id
   `ca59a12dcccf7`); `listDisputes({})` → 200, 0 items; `provideEvidence` multipart on the absent id →
   PayPal 404 `RESOURCE_NOT_FOUND` (debug id `ca59a12e2280b`) — so the whole filing request path (auth,
   multipart, endpoint, error mapping) is proven live; only a **real dispute** (HUMAN_TODO 1a/2: a
   captured payment and the Disputes product/simulator) and the **merchant approval click** (no surface
   yet) stand between this and a real filed packet. The filer's own upload path is covered by 72 tests
   against the real client; its fixtures are honestly doc-derived, not captured (H-01 open).
9. **[P1]** LLM path configurable, with graceful configured-off behaviour everywhere.
10. **[P1]** edge cases: every §12 row, including PayPal 5xx/timeouts, duplicate webhooks, concurrent
    checkouts on one budget, revoked mandate mid-checkout, refund after chargeback, tampered packets,
    prompt injection.
11. **[P1]** CI green: lint, typecheck, test, Python tests, Playwright e2e.
    11b. **[P1]** health surfaces: worker heartbeats, a `worker` section on `/status`, and a vi
    health check. ✅ **done 2026-11-13** (§7)
12. **[P2]** deploy readiness: Dockerfiles, Render config, health checks, migrations.
