# Plan — the agent checkout on the real-buyer path

Status: proposed, 15 November 2026. Branch: `prod/real-users`, base `e394cbb`.
Scope: `e` — a signed-in buyer with **no demo flags** must be able to create an L2 mandate in the
browser, run the agent, and reach a real PayPal order. Read-only analysis; no code changes in this
commit.

The lab is **not** touched: `apps/web/app/lab/device-sign/*` stays `signingLabAllowed`-gated and keeps
`usr_demo_user` (`apps/web/app/lab/device-sign/vi.ts:4`). It is the reference implementation we copy
from, not something we re-point.

---

## a. CURRENT FLOW

From "buyer types intent on `/agent`" to "PayPal order created". Line numbers are from `e394cbb`.

| #   | Step                                                                                                                                                  | Where                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Buyer submits the sentence and a cap; server component renders the chat only when the demo flag is on                                                 | `apps/web/app/agent/page.tsx:50`                                                                             |
| 2   | Anonymous → `/buyer-login`, non-buyer → 403 (before the demo flag is read)                                                                            | `apps/web/app/agent/page.tsx:44`, `:46`                                                                      |
| 3   | **Demo gate (UI).** Off → an explanation page, no button. This is the first thing a real buyer hits                                                   | `apps/web/app/agent/page.tsx:50` → `apps/web/lib/agent-session.ts:117`                                       |
| 4   | Client posts `{intent, cap_minor}` to `POST /api/agent/session`                                                                                       | `apps/web/app/agent/agent-chat.tsx:137`–`:158` (fetch at `:140`)                                             |
| 5   | **Demo gate (session route).** `COUNTERSIGN_AGENT_DEMO=1` and `NODE_ENV !== 'production'`, else 403                                                   | `apps/web/app/api/agent/session/route.ts:54`                                                                 |
| 6   | Buyer identity: `requireBuyer()` — the cookie decides whose mandate it is; body has no vote                                                           | `apps/web/app/api/agent/session/route.ts:108` (`apps/web/lib/auth.ts:364`)                                   |
| 7   | **Demo gate (provisioner).** Third copy of the same check                                                                                             | `apps/web/lib/agent-session.ts:225`                                                                          |
| 8   | vi config + merchant identity + per-process JWKS mirror                                                                                               | `apps/web/lib/agent-session.ts:233`–`:297`                                                                   |
| 9   | Buyer row re-read; non-`BUYER` persona refused                                                                                                        | `apps/web/lib/agent-session.ts:248`–`:272`                                                                   |
| 10  | Wallet: `pickActiveWallet` over real vault wallets; none → `CS_CONFLICT` 409 "Save a PayPal payment method on the Wallet page first."                 | `apps/web/lib/agent-session.ts:310`–`:319`                                                                   |
| 11  | Device key: **`createDemoDeviceKey()` — the server mints a P-256 key per session.** This is the fixture that has to go                                | `apps/web/lib/agent-session.ts:708` → `apps/web/lib/demo-device.ts:56`                                       |
| 12  | Thumbprint recomputed, `deviceKid` must be `dev_<jkt>`, device row reused or created (`Browser device`)                                               | `apps/web/lib/agent-session.ts:323`–`:359` (`createDevice` at `:351`, `findDeviceByJkt` at `:344`)           |
| 13  | vi `POST /v1/keys/agent` → agent kid + encrypted private key                                                                                          | `apps/web/lib/agent-session.ts:362`                                                                          |
| 14  | vi `POST /v1/l1/issue` binds that device key; L1 upserted on `(device_id, wallet_id)`                                                                 | `apps/web/lib/agent-session.ts:377`–`:402`                                                                   |
| 15  | Intent compiled by `compileIntent` (deterministic reader, model optional)                                                                             | `apps/web/lib/agent-session.ts:405` → `apps/web/lib/intent-compiler.ts:94`                                   |
| 16  | `assertStoreCurrency`, then `applyCap(constraints, capMinor, merchant)`; `line_items` projected by keyword match                                      | `apps/web/lib/agent-session.ts:407`–`:433`                                                                   |
| 17  | vi `POST /v1/l2/prepare` → `signing_input` (ASCII `header.payload`)                                                                                   | `apps/web/lib/agent-session.ts:507`                                                                          |
| 18  | Everything phase 2 needs is sealed into a 10-minute HMAC token                                                                                        | `apps/web/lib/agent-session.ts:535`–`:555`, `apps/web/lib/pending-session-token.ts:45`                       |
| 19  | **Server-side signature.** `deviceKey.sign(signingInput)` — the server holds the private half. This is the custody defect                             | `apps/web/lib/agent-session.ts:717`                                                                          |
| 20  | **Demo gate (finalize).** `finalizeAgentSession` re-checks the flag                                                                                   | `apps/web/lib/agent-session.ts:587`                                                                          |
| 21  | vi `POST /v1/l2/finalize` verifies the signature against its own prepare record → the L2                                                              | `apps/web/lib/agent-session.ts:629`                                                                          |
| 22  | `mandates` row written (`status: ACTIVE`), budget opened, wallet cap set                                                                              | `apps/web/lib/agent-session.ts:639`, `:660`, `:666`                                                          |
| 23  | Session response: ids + read-back + cap → mandate chip                                                                                                | `apps/web/app/api/agent/session/route.ts:133`–`:147`, chip at `apps/web/app/agent/agent-chat.tsx:322`–`:338` |
| 24  | Client posts `{user_id, mandate_id, agent_id, message, mode}` to `POST /api/agent/run` (SSE)                                                          | `apps/web/app/agent/agent-chat.tsx:184`                                                                      |
| 25  | **Demo gate (run route)** — fourth copy                                                                                                               | `apps/web/app/api/agent/run/route.ts:73`                                                                     |
| 26  | Buyer re-checked; `guardRunUser`, `requireOwnedMandate` (404), `requireOwnedAgent` (404); agent bearer minted                                         | `apps/web/app/api/agent/run/route.ts:107`, `:114`, `:124`, `:131`, `:136`                                    |
| 27  | Agent opens our own merchant MCP; `sessionMandatePort` + `sessionSigner(mandateId)` are the two ports                                                 | `apps/web/app/api/agent/run/route.ts:142`–`:160`                                                             |
| 28  | Agent shops → price lock → `sessionSigner.signCheckout` → vi `POST /v1/l3/create` (refusals are `refused: true`, not faults)                          | `apps/web/lib/agent-session.ts:1012`–`:1034`                                                                 |
| 29  | `submit_checkout` runs the 12-check Gate, persists `gate_decisions`, and on `ALLOW` calls `createOrderFromDecision` with the **vaulted** buyer wallet | `apps/web/lib/mcp-checkout.ts:144`, `:177`, `:197`–`:199`, `:59`                                             |
| 30  | Order row + `paypal_order_id`; if the order could not be placed the answer stays `order_pending: true` — an ALLOW is never turned into a BLOCK        | `apps/web/lib/mcp-checkout.ts:219`, note at `:90`                                                            |

Two things this table makes obvious:

- **The demo flag is checked four times on one request path** (`agent/page.tsx:50`,
  `api/agent/session/route.ts:54`, `agent-session.ts:225`, `agent-session.ts:587`,
  `agent-session.ts:700`, `api/agent/run/route.ts:73`). Removing it is a five-site edit, not one.
- **The money path is already real.** `createDemoOrder` (`apps/web/lib/demo-order.ts:141`) has **no
  call site** — grep for `createDemoOrder` finds only its definition and its own guard. The only live
  consumer of `demo-order.ts` is the re-read affordance `GET /api/agent/paypal-order`
  (`apps/web/app/api/agent/paypal-order/route.ts:23`, `:37`), which is gated by `demoOrderPossible()`
  (`apps/web/lib/demo-order.ts:89`). Orders are placed by `mcp-checkout.ts:59`. The demo flag is
  therefore **not** what blocks a real order; the device-key custody and the page gates are.

---

## b. WHAT A REAL BUYER NEEDS

1. **A buyer session.** Already correct: `requireBuyer` on both routes
   (`apps/web/app/api/agent/session/route.ts:108`, `apps/web/app/api/agent/run/route.ts:107`), plus
   `guardRunUser` / `requireOwnedMandate` / `requireOwnedAgent`. Nothing to build; the plan only
   removes the flag that sits _in front of_ these checks.

2. **A registered device key per buyer.**
   - Browser side: exists and is production-shaped — `getOrCreateDeviceKey` (non-extractable P-256,
     IndexedDB, per `userId`) and `signSigningInput` (`apps/web/lib/browser-keystore.ts:50`, `:102`).
     Only one caller today: the lab page (`apps/web/app/lab/device-sign/page.tsx:136`, `:208`).
   - Server side: `devices` table with `UNIQUE (user_id, jkt)` (`packages/db/src/schema.ts:467`–`:491`),
     `findDeviceByJkt` (`packages/db/src/repos/devices.ts:52`), `createDevice` (`:26`),
     `bindWebauthnCredential` (`:181` — **no caller anywhere**).
   - **A device registration route does not exist.** `git ls-files "apps/web/app/**/route.ts"` lists 27
     routes and none of them is a device/enrolment endpoint; the only `devices` write in the app is
     inside `prepareAgentSession` (`apps/web/lib/agent-session.ts:351`). **Missing.**
     It is _implicitly_ created by provisioning today (step 12 above) — acceptable for the L2, but a
     buyer whose browser key was cleared gets a second device row and no way to see or revoke the
     first, and `webauthn_credential_id` is never written.

3. **Browser-side L2 signing via prepare/finalize, scoped to the session buyer.**
   The two-phase server functions already exist and are already buyer-scoped:
   `prepareAgentSession` (`apps/web/lib/agent-session.ts:222`) takes `devicePublicJwk` + `deviceKid`
   and _verifies_ `deviceKid === dev_<thumbprint>` (`:334`); `finalizeAgentSession`
   (`apps/web/lib/agent-session.ts:584`) binds the HMAC token to `input.userId` and to one
   `prepareId` (`:606`, `:615`). What is missing is only:
   - two **HTTP routes** for these phases on the buyer path (the lab has them at
     `app/lab/device-sign/prepare/route.ts` and `.../finalize/route.ts`, but both are gated by
     `signingLabAllowed` (`app/lab/device-sign/vi.ts:29`) and hard-wire `usr_demo_user`
     (`app/lab/device-sign/vi.ts:4`), so they cannot be reused), and
   - a **client** that calls them and signs with `signSigningInput` — the lab page's `onPrepare` /
     `onSign` (`app/lab/device-sign/page.tsx:152`, `:191`) is the template.

4. **WebAuthn step-up.** Exists (`apps/web/lib/webauthn.ts:22`): creates a platform passkey on first
   use, stores only the credential id in IndexedDB, returns an assertion or `null` when the ceremony
   is unavailable/cancelled. The lab treats `null` as "do not sign"
   (`app/lab/device-sign/page.tsx:200`–`:204`). Two gaps for the real path: the assertion is never
   verified server-side, and the credential id never reaches `devices.webauthn_credential_id`
   (`bindWebauthnCredential` has no caller).

5. **A saved PayPal wallet (vault).** Exists: `app/api/wallet/vault/start|return|cancel/route.ts`,
   `app/wallet/page.tsx`, and the agent path reads it through `pickActiveWallet`
   (`apps/web/lib/active-wallet.ts:8` — excludes `DEMO-` and `SEED_PLACEHOLDER` tokens). The order
   path consumes it in `createOrderFromDecision` (`apps/web/lib/mcp-checkout.ts:59`).

6. **When the buyer has no device or no wallet.**
   - No wallet → `CS_CONFLICT` 409 with `userMessage` "Save a PayPal payment method on the Wallet
     page first." (`apps/web/lib/agent-session.ts:314`–`:318`), surfaced as `sessionError` text in the
     mandate panel (`apps/web/app/agent/agent-chat.tsx:316`). **The buyer is told, but not taken
     there** — `agent-chat.tsx` renders no link at all, and the only link on the wallet side is the
     static "Agent chat" back-link (`apps/web/app/wallet/page.tsx:90`).
   - **`/wallet?next=/agent` does not work today, and the plan does not pretend it does.** The wallet
     page's `searchParams` type declares only `saved`, `cancelled`, `error` and `vault_error`
     (`apps/web/app/wallet/page.tsx:23`–`:28`); it never reads `next`, and its own sign-in redirect is
     the literal `'/buyer-login?next=/wallet'` (`:57`). On the return leg, the vault routes hard-code
     the destination: `safeNextPath('/wallet', '/wallet')`
     (`apps/web/app/api/wallet/vault/return/route.ts:68`), `'/wallet?saved=1'` (`:123`),
     `'/wallet?vault_error=<code>'` (`:75`, `:83`, `:93`, `:119`) and `/wallet?cancelled=1`
     (`apps/web/app/api/wallet/vault/cancel/route.ts:5`). `safeNextPath` itself already exists and is
     the right validator (`apps/web/lib/next-path.ts:12`); what is missing is any wallet caller. So
     commit 4 **adds** `?next=` support to `/wallet` and to the vault return leg rather than assuming
     it.
   - No device key in this browser → today nothing happens, because the server mints one. After the
     change, the browser must create the key on first use (`getOrCreateDeviceKey`) and, when the key is
     gone but a `devices` row exists (IndexedDB cleared, other browser), refuse to sign and offer
     enrolment rather than silently minting a new device. The lab's `deviceLost` branch
     (`app/lab/device-sign/page.tsx:206`–`:217`, `:296`–`:315`) is the wording to reuse.
   - A `devices` row exists with `status: LOST`/`REVOKED`: `findDeviceByJkt` returns it and
     `prepareAgentSession` currently reuses it regardless of status (`agent-session.ts:347`
     re-binds the L1 to it at `:351`–`:357` and `:392`). **Bug to fix on the way through** — the row
     exists, but nothing on this path checks it: `assertDeviceActive`
     (`packages/db/src/repos/devices.ts:88`) is the guard that would refuse and has no caller here,
     and the mandate writer's only status check is `assertL1Usable` on the _credential_
     (`packages/db/src/repos/mandates.ts:253`), which never reads `devices.status`.

---

## c. COMPILER AMBIGUITY

Where it goes today: `compileIntent` (`apps/web/lib/intent-compiler.ts:94`) returns
`CompiledMandate.ambiguities` (`packages/compiler/src/types.ts:60` for the `Ambiguity` shape, `:130` for
the field; the compiler's own rule is "clarify before signing", §8.8).
`POST /api/intent/compile` passes them through — `intentResponseBody` copies them into the response body
(`apps/web/lib/intent-response.ts:79`, type at `:57`) and the route returns it verbatim
(`apps/web/app/api/intent/compile/route.ts:135`, `:143`). But the
**agent path never reads them**: `prepareAgentSession` uses only `compiledResult.value.constraints`
(`apps/web/lib/agent-session.ts:405`–`:433`), and the cap it applies is the one the client sent
(`apps/web/app/api/agent/session/route.ts:46`–`:49`, default `'5000'`).

So an intent with no stated limit ("something warm for the trip") is **silently signed at the UI's
default cap**. That is exactly the guess §8.8 forbids, and on the real path it would be a device
signature over a limit the buyer never said.

Proposed rule (deterministic, no model):

1. `prepareAgentSession` refuses when `compiledResult.value.ambiguities.length > 0`, with
   `CS_VALIDATION` and a `userMessage` naming the question (the ambiguity's own text). The refusal
   arrives **before** vi is called and before any row is written — the prepare call is step 17, the
   ambiguity check belongs at step 15.5.
2. The buyer answers in the chat ("…under $80"), and the client re-compiles. The wire contract that
   already exists for this is `POST /api/intent/compile`: the agent panel calls it to preview the
   read-back and the open questions before "Create mandate", and the mandate button stays disabled while
   the compiler reports a question. Nothing about this needs a new compile endpoint.
3. The client-supplied `cap_minor` stays only as a **ceiling**: `applyCap` already takes the smaller of
   the compiled max and the cap (`apps/web/lib/apply-cap.ts:72`), so it can only reduce
   authority. It must never be the _only_ limit in the mandate.
4. Never sign silently: no default cap, no "assume $50", no signing while an ambiguity is open. A BLOCK
   at the compiler is the same class of event as a Gate BLOCK, and it renders the same way.

---

## d. COMMIT PLAN

Seven commits. Each is green on its own: `pnpm lint && pnpm typecheck && pnpm test`, plus
`pnpm --filter @countersign/web test:e2e` where noted. Every commit stays on `prod/real-users`.

### 1. `feat(web): compile the buyer's intent before the mandate, and surface its ambiguities`

- **Files:** new `apps/web/lib/agent-intent.ts` (a thin buyer-scoped wrapper over `compileIntent`);
  `apps/web/lib/agent-session.ts` (call the wrapper; refuse on ambiguities).
- **Change:** `prepareAgentSession` refuses when `compiledResult.value.ambiguities` is non-empty, with
  `CS_VALIDATION` + the ambiguity's own question as `userMessage`. No vi call, no rows. The
  `cap_minor` request field is documented as a ceiling only.
- **Tests:** new `apps/web/lib/agent-intent.test.ts` (a sentence with no limit ⇒ refusal naming the
  question; a sentence with a limit ⇒ no refusal; the compiled cap never exceeds `capMinor`). Extend
  `apps/web/app/api/agent/session/route.test.ts` with "an ambiguous intent is 400, not 403/503".
- **Verify:** `pnpm vitest run apps/web/lib/agent-intent.test.ts apps/web/app/api/agent/session`.

### 2. `feat(web): POST /api/agent/mandate/prepare — buyer-scoped, device key from the request`

- **Files:** new `apps/web/app/api/agent/mandate/prepare/route.ts`; new
  `apps/web/app/api/agent/mandate/prepare/route.test.ts`; new `apps/web/lib/vi-client.ts` and its move;
  `apps/web/lib/agent-session.ts` (import path), `apps/web/app/lab/device-sign/vi.ts` (re-export
  nothing — its lab-only constants stay), `apps/web/app/lab/device-sign/vi.test.ts` if it pins the
  moved symbols.
- **Change:** the HTTP face of `prepareAgentSession`. `requireSameOrigin`, `requireBuyer`, zod on
  `{intent, cap_minor, deviceKid, devicePublicJwk}`, `prepareAgentSession` called with
  `buyer.value.id`. Returns `{prepareId, signingInput, readback, readback_summary, cap_display,
expires_at_epoch_sec, pending}`. **No demo gate** — this route replaces the gated one and must be
  reachable with no `COUNTERSIGN_AGENT_DEMO`. The `devicePublicJwk` shape is the one the lab route already
  accepts (`publicJwkSchema`, `app/lab/device-sign/prepare/route.ts:24`) and `agent-session.ts:325`
  already thumbs, so no new key format is introduced. Move `readServiceConfig`, `createViClient` and
  `AGENT_AUDIENCE` out of `app/lab/device-sign/vi.ts` into a new `apps/web/lib/vi-client.ts`; the lab's
  `USER_ID`/`AGENT_ID`/`DEVICE_ID`/`WALLET`/`signingLabAllowed` (`vi.ts:4`–`:7`, `:29`) stay in the lab.
  The import at `apps/web/lib/agent-session.ts:109`–`:114` follows, so no production file imports a lab
  module (risk 2).
- **Tests:** anonymous ⇒ 401; merchant ⇒ 403; mismatched `deviceKid` ⇒ 400; a foreign `user_id` in the
  body is ignored (the buyer comes from the cookie only).
- **Verify:** the new route test, plus `pnpm --filter @countersign/web typecheck`.

### 3. `feat(web): POST /api/agent/mandate/finalize — the buyer's signature, not the server's`

- **Files:** new `apps/web/app/api/agent/mandate/finalize/route.ts` + route test; new
  `apps/web/app/agent/mandate-sign.tsx` (client: prepare → step-up → sign → finalize) wired into
  `apps/web/app/agent/agent-chat.tsx`; `apps/web/app/agent/agent-chat.tsx` copy at `:341` corrected (it
  currently says "issues an L1 to a server-side demo device key").
- **Change:** `finalizeAgentSession` over HTTP, same guards, `pending` + `prepareId` + `signatureB64Url`
  in the body. The client calls `getOrCreateDeviceKey(user_id)`, then `stepUp(user_id, signingInput)`,
  then `signSigningInput(kid, signingInput)`; a `null` assertion means **do not sign** and says why.
  `provisionAgentSession` and `createDemoDeviceKey` are no longer called from any route.
- **Tests:** `finalize` route test (wrong buyer ⇒ 403; foreign `prepareId` ⇒ 403; expired `pending` ⇒
  400); extend `apps/web/tests/e2e/agent-chat.spec.ts` with the prepare/finalize round trip; keep the
  demo path passing for one commit (see 5) so the e2e suite stays green.
- **Verify:** `pnpm vitest run apps/web/app/api/agent/mandate` and the agent-chat e2e spec.

### 4. `feat(web): /agent states the mandate is signed in this browser, and links a buyer to /wallet`

- **Files:** `apps/web/app/wallet/page.tsx` (accept `next`), `apps/web/app/api/wallet/vault/return/route.ts`
  (forward `next`), `apps/web/app/api/wallet/vault/cancel/route.ts` (same), the two existing wallet route
  tests (`apps/web/app/api/wallet/vault/return/route.test.ts`, `.../start/route.test.ts`),
  `apps/web/app/agent/page.tsx`, `apps/web/app/agent/agent-chat.tsx`,
  `apps/web/app/api/agent/session/route.ts` (error `userMessage` only), new copy/test in
  `apps/web/app/agent/page.view.test.tsx` if the repo has no page test yet.
- **Change:** no-device and no-wallet are two named states with two named next actions: "Enrol this
  device" (create the key, retry prepare) and "Save a PayPal payment method" → `/wallet?next=/agent`.
  **This commit is where `?next=` starts to work** — the wallet page widens its `searchParams` type,
  validates `next` with `safeNextPath(params.next, '/wallet')` (`apps/web/lib/next-path.ts:12`, the same
  validator the auth pages use), and carries it through the vault round trip: `/api/wallet/vault/start`
  returns a redirect to PayPal, so the return path is what decides where the browser lands, and today it
  hard-codes `'/wallet'` (`app/api/wallet/vault/return/route.ts:68`, `:75`, `:83`, `:93`, `:119`) and so
  does the cancel path (`app/api/wallet/vault/cancel/route.ts:5`). The round trip keeps `?next=` in the
  return/cancel URLs (PayPal appends its own query parameters, so the reading side must tolerate
  `approval_token_id` beside it) and validates again on the way out. `/wallet` also links back to
  `/agent` as a plain string today (`app/wallet/page.tsx:90`); it becomes the validated path.
- **Tests:** wallet page test for `?next=` accepted / rejected (external, `//evil`, backslash);
  vault return route test asserting the redirect target; page test for the two states; e2e assertion
  that the wallet link leaves `/agent` and comes back.
- **Verify:** `pnpm vitest run apps/web/app/agent apps/web/app/api/wallet`.

### 5. `test(web): the e2e suite provisions a mandate through the browser, with no demo flag`

- **Files:** `apps/web/playwright.config.ts` (drop `COUNTERSIGN_AGENT_DEMO: '1'` from the web block,
  `:102`), `apps/web/tests/e2e/agent-chat.spec.ts`, `apps/web/tests/e2e/buyer-session.ts`,
  `apps/web/tests/e2e/disputes.spec.ts` (header comment at `:8` claims the flag is what enables the
  page), `apps/web/tests/e2e/device-sign.spec.ts` (lab spec — must keep `SIGNING_LAB_ENABLED`, which is
  a different variable and stays).
- **Change:** the e2e web server runs exactly like production: no `COUNTERSIGN_AGENT_DEMO`. WebAuthn in
  headless Chromium is driven by a virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`), which
  is the only way a real passkey ceremony can run in CI; if that proves unavailable the spec asserts the
  refusal path and the prepare step, and `docs/HUMAN_TODO.md` records the manual browser check.
- **Tests:** `agent-chat.spec.ts` green end to end; `disputes.spec.ts` unchanged in behaviour (the
  Defender demo is a different flag and keeps its own gate).
- **Verify:** `pnpm --filter @countersign/web test:e2e`.

### 6. `refactor(web): drop the agent demo gate from the real-user paths`

- **Files:** `apps/web/lib/agent-session.ts` (delete `agentDemoAllowed` at `:117`, the checks at `:225`,
  `:587`, `:700`), `apps/web/app/api/agent/session/route.ts:54`, `apps/web/app/api/agent/run/route.ts:73`,
  `apps/web/app/agent/page.tsx:50`, plus the two unit tests that mock the gate
  (`apps/web/app/api/agent/session/route.test.ts:19`/`:49`/`:105`,
  `apps/web/app/api/agent/run/route.test.ts:16`/`:75`) and
  `apps/web/lib/pending-session-token.test.ts:156`/`:174`.
- **Change:** `POST /api/agent/session` becomes an alias of the prepare route for one commit (deprecated
  header), then is deleted in commit 7. `agent/page.tsx` renders the chat for any signed-in buyer. The
  Defender demo keeps its own gate — it is a fixture, and `dispute-queue.ts:54` already has its own
  copy of the rule (`COUNTERSIGN_AGENT_DEMO`) which this commit does **not** touch; moving that flag to
  its own name is commit 7's last item. Two Defender readers import `agentDemoAllowed` by name rather
  than reading the environment (`app/api/disputes/demo/pdf/route.ts:16`, `lib/demo-order.ts:44`), so
  deleting the function without them would break the build — both are pointed at the Defender's own copy
  in commit 7, not here.
- **Tests:** the two route tests lose the "flag off ⇒ 403" cases and gain "signed-in buyer with no flag
  ⇒ provisioning runs"; `agent/page.tsx` test asserts the chat renders without the flag.
- **Verify:** `pnpm lint && pnpm typecheck && pnpm test` plus the full e2e run.

### 7. `refactor(web): retire the server-held device key and the demo order path`

- **Files:** delete `apps/web/lib/demo-device.ts` and `apps/web/lib/demo-order.ts`; delete
  `apps/web/app/api/agent/paypal-order/route.ts` and its panel in
  `apps/web/app/agent/agent-chat.tsx:618`–`:710`; delete `apps/web/app/api/agent/session/route.ts` and
  update `apps/web/app/status/route.ts:151`'s comment; rename the Defender's flag
  (`lib/dispute-queue.ts:54`, `app/disputes/page.tsx`, `app/disputes/demo-view.tsx`,
  `app/api/disputes/demo/pdf/route.ts`, `lib/defender-demo.ts`, `tests/e2e/disputes.spec.ts`,
  `playwright.config.ts`) from `COUNTERSIGN_AGENT_DEMO` to `COUNTERSIGN_DEFENDER_DEMO`; update
  `docs/DECISIONS.md` with **D-063** (the device key is the browser's, and a mandate is never signed by
  a key the server holds), `docs/PROGRESS.md`, `docs/EDGE-CASES.md`, `README` of `apps/web`.
- **Change:** the last server-held key and the last sandbox-only order affordance are gone. The money
  path is `mcp-checkout.ts` alone; the re-read panel goes because the order row (`orders` +
  `get_order_status`, `lib/mcp-checkout.ts:265`) is the merchant's record and re-reading PayPal from a
  buyer page was a demo affordance, not a product surface.
- **Tests:** delete the `paypal-order` route test if one exists; add a guard test that
  `agent-session.ts` contains no `createDemoDeviceKey` import (a one-line regression lock, the same
  shape as the existing ESLint rule that keeps `packages/gate` free of `ai`).
- **Verify:** full gate — `pnpm secret-scan && pnpm lint && pnpm typecheck && pnpm test && pnpm build`,
  then the full e2e run.

Ordering note: 1–4 are additive and each keeps the demo path working, so no commit leaves `main`-bound
CI red. 5 is the switch-over (the e2e suite stops relying on the flag). 6 removes the flag from the real
paths. 7 deletes what only the flag kept alive.

---

## e. RISKS / OPEN QUESTIONS

1. **WebAuthn in CI.** `stepUp` creates a _platform_ passkey with `userVerification: 'required'`
   (`apps/web/lib/webauthn.ts:22`, `:45`–`:61`). Headless Chromium needs
   CDP `WebAuthn.addVirtualAuthenticator`; without it commit 5's e2e can only assert the refusal. If
   that is where it lands, the e2e stays honest and the browser check is a human item.
2. **The Lab cannot be reused as-is.** `prepareAgentSession` imports `readServiceConfig`, `ViClient`
   construction and `AGENT_AUDIENCE` from `apps/web/app/lab/device-sign/vi.ts`
   (`apps/web/lib/agent-session.ts:109`–`:114`), so the real path already depends on a lab module for
   its vi client. The lab's own _identity_ constants (`vi.ts:4`–`:7`, `usr_demo_user` and friends) stay
   behind `signingLabAllowed` (`vi.ts:29`) and are not touched — but committing the two new buyer
   routes means that file becomes the shared home of the vi client, which is a rename worth doing in
   commit 2 rather than leaving a production import pointed at a lab directory.
3. **Per-session `mandates` rows.** Every provision writes a mandate, a budget and a wallet cap
   (`agent-session.ts:639`–`:667`), and `setWalletCap(..., 'MONTH', cap)` overwrites the wallet's cap
   each run. A real buyer clicking "Create mandate" twice replaces their own monthly cap. Is a
   per-session mandate the right product shape, or should one mandate be reused until it expires?
   (Open question, not a blocker for the first cut — document the answer as a decision.)
4. **Step-up is not verified server-side.** The assertion from `webauthn.ts` is currently a UI gate only;
   `bindWebauthnCredential` (`packages/db/src/repos/devices.ts:181`) has no caller, so
   `devices.webauthn_credential_id` (`packages/db/src/schema.ts:479`) stays null forever. Real UV
   enforcement needs a server challenge and a verify step, which is its own work package — do not fold
   it into this one silently.
5. **A cleared browser is a new device.** `getOrCreateDeviceKey` keys IndexedDB by `userId`
   (`browser-keystore.ts:29`, `:50`); clearing site data loses the key while the `devices` row remains,
   and `prepareAgentSession` reuses a row by `(user_id, jkt)` — a _new_ jkt means a _new_ row, so old
   mandates keep verifying against a key nobody holds. The product answer (revoke-on-re-enrol, device
   list, `markDeviceLost`) is not in this plan; the plan only refuses to sign silently and offers
   enrolment.
6. **`COUNTERSIGN_AGENT_DEMO` is also the Defender's flag.** `dispute-queue.ts:54` reads the same
   variable for fixture disputes. Deleting the variable without renaming that reader breaks `/disputes`
   in production. Commit 7 renames it; commits 1–6 must not touch it. Five more readers sit outside the
   step-2 pathspec and need the same treatment in commit 7: `apps/web/app/api/disputes/demo/pdf/route.ts`
   imports `agentDemoAllowed` directly (`:16`, `:27`), `apps/web/lib/demo-order.ts` imports it (`:44`) and
   calls it at `:92`, and `scripts/agent-acceptance.mts` (`:10`, `:188`) plus
   `scripts/agent-refusal.mts` (`:5`) name the variable in their headers. The unit tests that stub it —
   `apps/web/lib/dispute-queue.test.ts:284`–`:296` — are the Defender's and are renamed with the flag.

   The brief caps this section at five items; item 6 is recorded here rather than dropped because it is
   a build-breaker if missed, not a preference.

### Human-only needs

None new. The two standing items that this plan depends on are already recorded: the PayPal sandbox
vault save (`docs/HUMAN_TODO.md`, "Perform one manual PayPal sandbox vault save…") and `NODE_ENV` in
`.env.local`. No edit to `docs/HUMAN_TODO.md` is made by this commit. If commit 5 lands without a
virtual authenticator, the missing browser check gets added there at that point.
