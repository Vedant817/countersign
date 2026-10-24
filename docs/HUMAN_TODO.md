# HUMAN TODO — things only Vedant can do

_Last updated: 26 October 2026_

Agents keep working on everything that is not blocked by one of these. **Newest request goes at the top.**
When you complete an item, move it to `docs/DONE_BY_HUMAN.md` with the date.

The deadline is **Fri 13 Nov 2026, 1:30 AM IST**. Internal target: submitted by Wed 11 Nov.

**Why this list is short and blunt:** a judge-panel review on 25 Oct scored the project **21/50** and found
it is "a well-engineered payments-security library with no product on top of it"
(`docs/review/VERDICT.md`). Every item below is on the critical path out of that. Items 1–5 unblock
roughly two thirds of the remaining P0 work; nothing else can proceed until they land.

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

Then `packages/orders.createOrderFromDecision` (P0-4) can send the vault id and the run can capture.
Until then the agent demo reports `order_pending: true` and a sentence saying so, which is the honest
state rather than a claim.

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
