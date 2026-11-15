# HUMAN TODO — things only Vedant can do

_Last updated: 13 November 2026_

Agents keep working on everything that is not blocked by one of these. **Newest request goes at the top.**
When you complete an item, move it to `docs/DONE_BY_HUMAN.md` with the date.

The deadline is **Fri 13 Nov 2026, 1:30 AM IST**. Internal target: submitted by Wed 11 Nov.

**Why this list is short and blunt:** a judge-panel review on 25 Oct scored the project **21/50** and found
it is "a well-engineered payments-security library with no product on top of it"
(`docs/review/VERDICT.md`). Every item below is on the critical path out of that. Items 1–5 unblock
roughly two thirds of the remaining P0 work; nothing else can proceed until they land.

---

## ☐ Remove `NODE_ENV=development` from your local `.env.local` (one line)

**Blocks:** nothing in CI; it only breaks `pnpm build` on this laptop.

**Context:** `.env.local` (line 9, gitignored, so agents cannot and should not edit it) sets
`NODE_ENV=development`. `next build` loads `.env.local`, so a local build runs in development mode and dies
while prerendering `/_global-error` with `"useContext" of null` — the same commit builds green in CI, which
sets no `NODE_ENV`. Diagnosed 15 November 2026; `NODE_ENV=production pnpm build` on top of the same tree
exits 0.

**Fix (either one):**

- Delete the `NODE_ENV=development` line from `.env.local` — `pnpm dev:local` and `next dev` force
  development themselves, so the line is redundant there. **Preferred.**
- Or keep it and always build as `NODE_ENV=production pnpm build`.

`NODE_ENV` is not set at User or Machine level, so there is nothing to change in Windows environment
variables.

---

## ☐ Perform one manual PayPal sandbox vault save in a browser at http://127.0.0.1:3000/wallet

**Blocks:** live PayPal vault payment token for the seeded buyer (Asha) on the local dev stack.

**Status (15 Nov 2026): automated attempts are blocked at PayPal's own login, not at consent.** The US
accounts and the app's Vault switch are in place, and everything before PayPal answers is verified:

- OAuth token from `https://api-m.sandbox.paypal.com/v1/oauth2/token`: **HTTP 200, `access_token` present**.
- Re-seed with `.env.local` loaded: `store paypal_merchant_id equals PAYPAL_MERCHANT_ID: true`,
  `buyer password hash present: true`, `merchant password hash present: true`.
- Buyer sign-in at `/buyer-login` and the "Save a PayPal payment method" button both work; the flow
  reaches `https://www.sandbox.paypal.com/...`.
- `PAYPAL_BUYER_EMAIL` is a sandbox personal address of the form `sb<16 chars>@personal.example.com`.

**The exact blocker (attempt 2 of 3, real output):**
```
FAILED STEP: paypal_consent
URL: https://www.sandbox.paypal.com/agreements/approve
ERROR: PayPal approval step failed: TimeoutError: page.waitForURL: Timeout 30000ms exceeded.
Page: <p class="nonjsAlert" role="alert">NOTE: Many features on the PayPal Web site require Javascript
and cookies.</p>Pay with PayPalEnter your email address to get started.Already set up to use your mobile
number to log in? Type it below. Otherwise, click the link to log in with email.Forgot your email
```
Screenshot: `%TEMP%\cs-vault-paypal_consent.png` (outside the repo). So the page that came back is a
**fresh email-entry page, not the consent screen**: the password step did not actually authenticate the
sandbox buyer, and the script's Step 4 looked for a consent button that was never going to exist.

Two likely causes, and both are for you to check in the dashboard rather than for us to guess at:
1. The `sb…@personal.example.com` address is not a usable password login for this sandbox account (PayPal
   now issues sandbox personal accounts whose sign-in is not the generated `sb…` address), or
2. `PAYPAL_BUYER_PASSWORD` no longer matches that account.

**What we need from you (10 minutes, in the visible browser):**

1. Open <https://developer.paypal.com/dashboard/accounts>, copy the **exact email** and **System
   Generated Password** of the US personal sandbox buyer, and put both in `.env.local` as
   `PAYPAL_BUYER_EMAIL` / `PAYPAL_BUYER_PASSWORD` (the dashboard password is shown once per account; use
   "View/Reset" if it is hidden).
2. Log in to <https://www.sandbox.paypal.com> by hand with those two values and confirm you reach the
   account overview. If PayPal asks for a mobile/OTP step, say so — that makes the flow manual-only and
   the script cannot complete it.
3. Tell us, and the headed re-run is
   `HEADED=1 BASE_URL=http://127.0.0.1:3000 node --env-file=.env.local ./node_modules/tsx/dist/cli.mjs apps/web/scripts/sandbox-vault-save.mts`.

**Two environment notes found while running it (neither is a PayPal block):**
- `localhost` resolves to `::1` first on this machine while Next binds IPv4 only, so
  `http://localhost:3000/buyer-login` is a **404**; `http://127.0.0.1:3000/...` is 200. The script now
  defaults to `127.0.0.1`, so `BASE_URL` no longer has to be passed.
- `pnpm build` will fail while `NODE_ENV=development` is in `.env.local` — that line is already gone, so
  this note is history.

---

**Context:** Setup-token payload now matches PayPal's documented example (commit after eaa4f99) and PayPal still shows `checkoutweb/genericError` at consent right after a successful sandbox login. Most likely cause is account eligibility: saving PayPal wallets without a purchase is only offered for business accounts in supported countries (US, UK, EU, CA, AU, JP, SG, HK and others; India is NOT on PayPal's list: https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/). Fix: in the PayPal Developer Dashboard > Testing Tools > Sandbox Accounts, check the country of the sandbox BUSINESS account whose merchant ID equals PAYPAL_MERCHANT_ID and of the sandbox PERSONAL buyer account. If either is IN, create a US business account and a US personal account, create a REST app on the US business account with Vault enabled (App Feature Options > Accept payments > Advanced options > Vault), update PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MERCHANT_ID, PAYPAL_BUYER_EMAIL and PAYPAL_BUYER_PASSWORD in .env.local, re-run `pnpm db:seed`, then run `HEADED=1 PW_CHANNEL=chrome pnpm --filter @countersign/web exec tsx scripts/sandbox-vault-save.mts`.

**Steps to complete:**

1. Ensure the dev stack is running (`pnpm dev:local`).
2. Open `http://localhost:3000/buyer-login?next=/wallet` in your browser.
3. Sign in using buyer email `buyer.countersign@example.com` and the `BUYER_PASSWORD` configured in `.env.local`.
4. Click **"Save a PayPal payment method"**.
5. In the PayPal sandbox window, log in with `PAYPAL_BUYER_EMAIL` and `PAYPAL_BUYER_PASSWORD` from `.env.local` and click **"Agree & Continue"**.
6. Once redirected back to `http://localhost:3000/wallet?saved=1`, the real PayPal vault payment token will be recorded in the local database.

---

## ☐ Set BUYER_PASSWORD and MERCHANT_PASSWORD in .env.local to passwords of your choice

**Done by the agent on 15 Nov 2026:** both were absent; `scripts/check-ids.mjs` appended a 24-character
`crypto.randomBytes(18).toString('base64url')` value to each (never printed), and `pnpm db:seed` reported
`merchant password sign-in configured` and `buyer password sign-in configured`. Rotation is still yours if
you want your own values — changing the line and re-running `pnpm db:seed` is the whole procedure.

---

## ☐ Pre-deploy check: verify and resolve orphaned orders before migration 0010

**Blocks:** deploying migration 0010 (`orders.merchant_id` becomes `NOT NULL`).

Before deploying migration 0010: run the step-3 count query on the production DB; any order whose payee matches no merchant must be assigned to its real merchant by hand (or the merchant must link that PayPal merchant id at `/merchant/settings`) or the migration will stop.

Read-only SQL:

```sql
SELECT count(*)::int AS total_orders FROM orders;

SELECT count(*)::int AS orders_without_merchant FROM orders WHERE merchant_id IS NULL;

SELECT count(*)::int AS resolvable_null_orders
FROM orders o
JOIN checkout_attempts a ON a.id = o.attempt_id
JOIN merchants m ON m.paypal_merchant_id = a.payee
WHERE o.merchant_id IS NULL;
```

- Production: the MERCHANT_ID env var must equal the PayPal merchant ID the store owner links in /merchant/settings; until it does, /shop/checkout returns 503 and takes no orders.

---

## ☐ 6. Set the merchant's password so `/login` has a merchant to sign in

**Blocks:** the merchant half of PROD_AUDIT item 6 (real accounts). The code is complete and fails closed:
with no password provisioned, `/login` refuses every attempt rather than accepting a blank one.

1. Pick a password and put it in `.env.local` (and in the Render environment when deployed):
   `MERCHANT_PASSWORD=<a long random value>`. Treat it as a secret; it is in `SECRET_ENV_KEYS` and is
   never printed.
2. Apply the migration and re-run the seed so the scrypt hash lands on the Northwind row:
   ```powershell
   pnpm db:migrate
   pnpm db:seed
   ```
   The seed prints `merchant password sign-in configured` when it worked. Re-running it is idempotent, and
   changing `MERCHANT_PASSWORD` and re-seeding is how the password is rotated.
3. Sign in at `/login` with `merchant.northwind@example.com` and that password. `/disputes` and
   `/api/disputes/*` now require this account; a buyer session gets 403.

**Alternatives recorded, not built:** a passwordless **magic link** needs a real email sender this
deployment does not have, and **Log in with PayPal** needs app scopes/credentials the sandbox app is not
configured for. Both would replace the password path in `lib/auth.ts` without touching the session, rate
limit or role checks; neither is a blocker for the merchant approval flow.

---

## ☐ 0. Rotate the Modal proxy token (agent log exposure)

While inspecting configuration on 13 Nov 2026, an agent printed `.env.local` **values** to the terminal
instead of names and lengths. `MODAL_PROXY_TOKEN_ID` and `MODAL_PROXY_TOKEN_SECRET` appeared in that log
(the LLM proxy in front of the model endpoint — not a PayPal or signing credential). No value is recorded
here. Regenerate that token pair in Modal and update `MODAL_PROXY_TOKEN_ID` /
`MODAL_PROXY_TOKEN_SECRET` in `.env.local` and in the deployment's environment.

---

## ★ 1a. A vaulted buyer, so the agent's purchase can end in a **capture**

**Blocks:** P0-6's last inch. The shopping agent now runs the whole path — real mandate, real vi-signed
chain, real Gate ALLOW, and a **real PayPal sandbox order** (`docs/verification/P0-6.md`,
order `6KW70371X5666381D`). It stops there on purpose: capturing needs
`payment_source.paypal.vault_id`, i.e. a **saved payment method**, and there are no buyer credentials in
`.env.local` yet (`PAYPAL_BUYER_EMAIL`/`PASSWORD` are empty, and the sandbox REST app does not have
**Vault / Save payment methods** enabled).

What is needed, in one line each:

1. Enable **Vault** on the `countersign-sandbox` REST app (developer.paypal.com → Apps & Credentials).
2. Set `PAYPAL_BUYER_EMAIL` / `PAYPAL_BUYER_PASSWORD` for the default personal sandbox account.
3. Set `PAYPAL_MERCHANT_ID` to the **PayPal** payer id of the Business account (`MERCHANT_ID` is ours,
   `mrc_northwind`; PayPal rejects it as a payee with `INVALID_STRING_LENGTH` — see
   `scripts/paypal-order-probe.mts`).

   **Done in code (14 Nov 2026), not yet in data:** the runtime now _prefers_ `PAYPAL_MERCHANT_ID` and
   falls back to `MERCHANT_ID` — one helper, `paypalMerchantIdFromEnv` in `packages/core/src/env.ts`, used
   by the seed (`packages/db/src/seed/run.ts`), the checkout's merchant identity
   (`apps/web/lib/merchant.ts`), `scripts/dev-local.mjs` and the two PayPal scripts. So once the value is
   in `.env.local` the checkout signs it as `payee_id` and `orders.create` sends it as
   `payee.merchant_id`. **The local database must be re-seeded once** (`pnpm db:seed`) for the existing
   `merchants` row to pick it up: the row is keyed on `owner_user_id`, and a re-seed updates
   `paypal_merchant_id` in place.

   This item stays **open** until a real sandbox order is created and confirmed with that id.

Then `packages/orders.createOrderFromDecision` (P0-4) can send the vault id and the run can capture.
Until then the agent demo reports `order_pending: true` and a sentence saying so, which is the honest
state rather than a claim.

**Re-confirmed against the live sandbox on 13 Nov 2026 (real output, through our own `PayPalClient`):**
an order is created fine (`201`, id `9R507478R17897236`, status `CREATED`, links `self, approve, update,
authorize`), and every money call behind it is refused by PayPal itself:

| Call                                                  | PayPal's answer                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `authorizeOrder`                                      | `422 UNPROCESSABLE_ENTITY` / issue `ORDER_NOT_APPROVED` — "Payer has not yet approved the Order"                         |
| `captureOrder` (AUTHORIZE intent)                     | `422 UNPROCESSABLE_ENTITY` / issue `ACTION_DOES_NOT_MATCH_INTENT`                                                        |
| `POST /v2/checkout/orders` with `payment_source.card` | `422` / issue `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` — "Payee account is not setup to be able to process card payments" |

So there are **two** independent PayPal-side switches, and either one unblocks a capture path:

1. **Vault** (item 1a above) — then the production order can carry `payment_source.paypal.vault_id`.
2. **Card processing** — the `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` error says the merchant app cannot take
   card payments at all; enabling it would allow a card-funded order to be captured with no vault and no
   buyer login. If you would rather demo a card capture than a vaulted wallet, this is the cheaper switch.

Neither is a code task: the client calls are written and tested, and the app refuses rather than faking a
capture. `listDisputes` answers `200` today with no disputes, and `getDispute`/`getCapture` map PayPal's
`404 RESOURCE_NOT_FOUND` to `PP_NOT_FOUND` — the disputes half needs a real captured payment first.

---

## ☐ 1. Make the GitHub repo public, with the licence visible in About

**Blocks:** the submission itself. A private repo is an outright rules failure — Devpost requires "public
and open source, with a license file visible at the top of the repo (in the About section)".

```powershell
gh repo edit Vedant817/countersign --visibility public --accept-visibility-change-consequences
```

Then, in the GitHub web UI → **About** (gear icon, top right of the repo page):

- **Website:** the deployed URL from item 5 — leave blank until that exists rather than pointing somewhere wrong
- **Topics:** `paypal`, `agents`, `payments`, `verifiable-intent`, `mcp`

The licence file already exists and is Apache-2.0. GitHub should show the badge automatically once the
repo is public; if it does not, the file is `LICENSE` at the root and that is all it needs.

**Acceptance:** an anonymous `git clone https://github.com/Vedant817/countersign.git` works in a shell
with no credentials, and the repo page shows "Apache-2.0 license" in the sidebar.

**This is a one-way door.** It is safe — the secret scan passes over the full history and there is no
proprietary content — but it cannot be undone quietly.

---

## ☐ 2. PayPal sandbox: four accounts, a REST app with Vault, and the Disputes product

**Blocks:** P0-2, P0-3, P0-4, P0-5, P0-8, P0-10 — every "real PayPal" acceptance test. This is the single
highest-value hour on the list.

At <https://developer.paypal.com> → **Dashboard → Sandbox → Accounts**:

| Account  | Email must contain | Country | Why                                                         |
| -------- | ------------------ | ------- | ----------------------------------------------------------- |
| Business | —                  | US      | The merchant; its **payer id** becomes `PAYPAL_MERCHANT_ID` |
| Personal | —                  | US      | The default buyer                                           |
| Personal | `allowappeal`      | US      | Used for the appeal-path dispute tests ([V3, S29])          |
| Personal | `noappeal`         | US      | The non-appeal path                                         |

Two Personal accounts are created for you; **create two more** and rename them so the emails contain the
words above. Set **country = US on all four** — that matches the USD store and keeps India-region account
capabilities out of the critical path.

Then **Apps & Credentials → Sandbox → Create App**, name it `countersign-sandbox`, link it to the
Business account, and:

- **Enable Vault / "Save payment methods".** The setting name varies between dashboard versions — the
  earlier probe returned `CUSTOMER_ID_NOT_FOUND`, which means the API processed the lookup, so Vault
  appears to be on for the default app. **Screenshot the setting** into `docs/sandbox-setup.md` either
  way, so the next reader is not guessing.
- **Enable the Disputes product.** If the dashboard offers scopes, request `disputes/create` and
  `disputes/update-buyer`. If it does not, note that here — the fallback is the dashboard's dispute
  simulator, and `POST /v1/customer/disputes` is then unavailable rather than broken.
- **Fund the default buyer** and confirm it has a linked card. The `process-chargeback` path requires a
  card-funded transaction.

Into `.env.local` (never committed — `.env*` is ignored except `.env.example`):

```
PAYPAL_CLIENT_ID=<from the app>
PAYPAL_CLIENT_SECRET=<from the app>
PAYPAL_MERCHANT_ID=<the Business account's payer id>
PAYPAL_BUYER_EMAIL=<default Personal account>
PAYPAL_BUYER_PASSWORD=<its password>
PAYPAL_ALLOWAPPEAL_EMAIL=<…allowappeal…@…>
PAYPAL_NOAPPEAL_EMAIL=<…noappeal…@…>
```

`PAYPAL_ENV=sandbox` and `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com` are already set and correct.

**Also worth asking PayPal support while you are in there:** what `PayPal-Request-Id` length is _actually_
enforced? Their docs say 38 characters; our validator currently permits **55**
(`packages/paypal/src/idempotency.ts`), which is a live defect — an id that passes validation and is
rejected at capture is exactly the case where a retry can double-charge. Their answer decides whether the
fix is "hash to 38" or "the validator is fine".

**Acceptance:** `POST /v1/oauth2/token` returns 200 (already true), and a Vault `setup-token` →
`payment-token` round trip returns a real `vault_id` that is stored against the user row.

---

## ☐ 3. Confirm the webhook registration in the dashboard (the agent does the rest)

**Blocks:** P0-5.

You do **not** need to create the webhook. Once item 5 gives us a public URL, the agent calls
`POST /v1/notifications/webhooks` itself and stores `PAYPAL_WEBHOOK_ID` in the environment.

What is needed from you: after the agent says it has registered one, open
**Dashboard → your app → Webhooks** and confirm the URL is the deployed one and the event list matches
spec §8.12. That is the whole ask — a second pair of eyes on one settings page.

**Acceptance:** the dashboard shows the webhook URL as our deployed `/api/webhooks/paypal`, and a
`PAYMENT.CAPTURE.COMPLETED` event appears in its delivery log with a 2xx response.

---

## ☐ 4. An LLM key a judge can actually reach

**Blocks:** P0-7, and the "AI is meaningful and reproducible by judges" criterion.

Today the model runs through a **private, proxy-authenticated Modal endpoint**
(`MODAL_PROXY_TOKEN_ID` / `MODAL_PROXY_TOKEN_SECRET`). That works, and it is why the intent compiler runs
at all — but a judge cannot reproduce it, and the panel scored the AI down for exactly that.

**Preferred:** an `OPENAI_API_KEY`. `apps/web/lib/llm.ts` already supports any OpenAI-compatible provider
via `OPENAI_BASE_URL`, and a plain key with no proxy headers is the path that works out of the box.

**Acceptable alternative:** any provider with structured outputs — Groq, OpenRouter, Together, Google AI
Studio, or a locally-hosted model. Put the base URL in `OPENAI_BASE_URL` and the key in `OPENAI_API_KEY`.

The Modal path stays as a fallback; it just stops being the default a judge has to be given a token for.

**Acceptance:** with only `OPENAI_API_KEY` and `OPENAI_BASE_URL` set, `/intent` compiles a sentence and
`/status` reports the provider `up`.

---

## ☐ 5. A host with credits, and billing approval for a managed Postgres

**Blocks:** P0-11, and therefore P0-5, P0-7, P0-10 and the video — anything that needs a public URL.

`render.yaml` is already written for **web + vi + worker + Postgres**. Two things are needed:

- A Render account with credits (**preferred** — the blueprint is written for it and the blueprint is
  itself a prize track), **or** explicit approval to use Vercel or Fly instead.
- **Billing approval for the paid Postgres.** The free tier expires and takes the demo with it; the
  judging window runs to **15 Dec 2026**, so the database has to survive at least that long.

**On the URL:** it must not collide with `countersign.vercel.app`, which is **an unrelated legal-drafting
product** (verified: HTTP 200, _"Countersign: the tool drafts. A human with a license signs."_). Use
something like `countersign-pay.onrender.com`, and put **"Countersign for PayPal agent payments"** in the
page title so a judge searching the name lands on us rather than on them.

While you are here: the **Bryntum** trial licence is only needed if the disputes timeline ships
(P1). Skip it unless that work starts — it must not lapse during 2–15 Dec if it is used at all.

**Acceptance:** `curl https://<our-url>/status` returns all-green from outside, and a cold start is under
60 s or the service is kept warm.

---

## ☐ 6. One manual PayPal buyer login, if 2FA or a captcha blocks Playwright

**Blocks:** the Vault onboarding E2E (P0-3) and the Judge Mode purchase runs (P0-10).

Sandbox buyer logins are usually automatable, but PayPal sometimes interposes a captcha or an OTP. If the
Playwright run stalls on the login popup, this is a **10-minute pairing session** — you log in once by
hand, we keep the browser profile, and the automation resumes from an authenticated session.

**This is conditional.** Do not do it pre-emptively; wait until a run actually blocks.

**Acceptance:** none needed — it is a fallback, and the honest state is "not required yet".

---

## ☐ 7. A YouTube channel for a Public upload, and a decision on narration

**Blocks:** P0-13, and the Devpost video field.

- A YouTube account where the demo can be uploaded as **Public** (unlisted does not satisfy the rules).
- **Your voice**, recorded from the script — or explicit approval for a TTS voice. Your call, and it is
  the difference between a video that sounds like a person and one that does not.

The script is in the brief (P0-13): problem → passkey-signed intent → agent buys via MCP with a real
capture → injection BLOCKED → revoke voids an authorization → dispute filed and evidenced → public
verifier QR → honest refund → Judge Mode. Target **2:45**, hard cap **2:55**.

**Acceptance:** the video is < 3:00, uploaded Public, and its link is in the README.

---

## How these were verified

`docs/review/REVERIFY.md` re-checks every judge finding with a command or a file citation:
`node scripts/reverify-findings.mjs`. The two that shape this list most:

- **F1** — the repo really is private. `gh repo view` → `visibility=PRIVATE`, `homepageUrl=""`.
- **F2** — the PayPal client declares **33 endpoints** (`/v2/checkout/orders`, captures, refunds,
  disputes, webhooks) and **zero of them has ever been called**. `packages/paypal/test/fixtures/README.md`
  says "zero real captures" in its first line. Item 2 is what changes that sentence.
