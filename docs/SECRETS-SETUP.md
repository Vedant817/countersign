# Secrets setup — what to get, where, and how to put it in `.env.local`

Every secret this project needs, in the order that unblocks the most work. Nothing here is committed:
`.env.local` matches `.gitignore` line 3 (`.env.*`), and only `.env.example` is tracked.

Check any time with:

```sh
git check-ignore -v .env.local     # → .gitignore:3:.env.*    .env.local
```

**Where we are already.** `.env.local` was generated for you and contains real values for
`SESSION_SECRET`, `VI_SERVICE_TOKEN`, `VI_KEK` and `GATE_SIGNING_KEY`. Those are machine-generated,
loopback-only, and regenerating them is safe. **Sections 1 and 2 below are the only ones that need
you**, and section 1 is the one that matters most.

Legend: 🔴 blocks work · 🟡 needed for the hosted demo · ⚪ optional.

---

## 1. 🔴 PayPal sandbox — unblocks the entire critical path

**Why it matters.** Everything from WP-06s onward — vault onboarding, live order creation, dispute
filing, Judge Mode's four scenarios — is written against PayPal's real API and currently cannot run.
It is the single biggest unblock in the project.

**Time: ~20 minutes.** No approval, no money, no real account touched.

### 1a. Sign in to the developer dashboard

1. Go to <https://developer.paypal.com/dashboard/> and log in with a normal PayPal account
   (a personal one is fine — sandbox is entirely separate).
2. If you have never used it, accept the developer agreement.

### 1b. Create the four sandbox accounts

1. Left sidebar → **Testing Tools → Sandbox Accounts**. PayPal creates one **Business** and one
   **Personal** account for you.
2. Set the **country to United States** on every account (the demo store prices in USD; a non-US
   sandbox account changes the funding behaviour).
3. Create **three more Personal** accounts and put these exact words in the **email address**:
   - one containing `allowappeal`
   - one containing `noappeal`
   - one more ordinary buyer

   The emails are ordinary sandbox addresses — `buyer-allowappeal@yourdomain.test` is fine. The
   project matches on the substring (spec §10.1 step 1).

### 1c. Create the REST app **with Vault enabled**

1. **Apps & Credentials** → make sure the toggle is on **Sandbox** (not Live) → **Create App**.
2. Name it `countersign-sandbox`, and pick your **Business** account as the app's owner.
3. Before saving, tick the feature **"Save payment methods"** (older revisions call it **Vault**).
   - ⚠️ **This is the one that bites.** Without it `/v3/vault/*` returns `400` and no part of the
     wallet path works. If you cannot find the toggle, save the app anyway and edit it afterwards —
     the setting moves between dashboard revisions.
4. Save, then copy the **Client ID** and **Secret**.

```
PAYPAL_CLIENT_ID=<paste the Client ID>
PAYPAL_CLIENT_SECRET=<paste the Secret>
```

### 1d. Fund the buyer

1. **Sandbox Accounts** → your ordinary Personal buyer → **View/Edit** → **Funding** → add a
   balance (a few thousand USD is plenty) or confirm the linked card.
2. `POST /v1/customer-support/process-chargeback` needs a **card-funded** transaction, so a
   balance alone is not enough for the dispute simulator (spec §10.1 step 5).

### 1e. Register a webhook

1. In your app → **Webhooks** → **Add Webhook**.
2. URL: `https://<your-public-base>/api/webhooks/paypal` — locally you have no public URL, so
   register it once the Render deploy exists (section 3). Leave this blank for now and the ingest
   route will refuse to trust events rather than accept a forgery (EC-WH-4).
3. Subscribe to at least: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`,
   `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`.
4. Copy the webhook **ID** (not the URL).

```
PAYPAL_WEBHOOK_ID=<paste the webhook id>
```

### 1f. The four remaining values

| Variable                           | Where                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `PAYPAL_BUYER_EMAIL`               | Sandbox Accounts → the ordinary Personal buyer's email                                            |
| `PAYPAL_BUYER_PASSWORD`            | Same row → the account's sandbox password is **not** shown; click **Set Password** and choose one |
| `PAYPAL_MERCHANT_ID`               | Your **Business** account → the account id (not the email). Needed by `process-chargeback`        |
| `PAYPAL_TEST_BUYER_TRANSACTION_ID` | Leave blank. It is filled in once, from a real sandbox capture, by `scripts/` — see H-09          |

**Tell me when this is done** and I will run the week-1 checks (C1/C2/C3b), wire vault onboarding
(WP-07) and produce the sandbox evidence.

---

## 2. 🔴 The model provider — free options, no credit card

**Why it matters.** WP-13's shopping agent and WP-15c's dispute-note drafting are the two places a
model is used. Without one they run deterministic fallbacks — which is by design (`§8.0` rule 4),
but it means I cannot exercise the real paths or publish honest eval numbers for the README.

**You do not need OpenAI.** I have added `OPENAI_BASE_URL` to the env schema, and `.env.local`
already points at the first option below. Pick one, paste one key, done.

### Option A — Groq (recommended: free, fastest, no card)

1. Go to <https://console.groq.com/keys> and sign in with Google or GitHub.
2. **Create API Key**, name it `countersign`, copy it (starts `gsk_`).
3. Paste into `.env.local` — **already configured for Groq**, so only the key is missing:

```sh
OPENAI_API_KEY=gsk_...
OPENAI_BASE_URL=https://api.groq.com/openai/v1
LLM_MAIN_MODEL=llama-3.3-70b-versatile
LLM_CHEAP_MODEL=llama-3.1-8b-instant
```

### Option B — OpenRouter (free models, widest choice)

1. <https://openrouter.ai/keys> → sign in → **Create Key**.
2. Use a model whose name ends `:free`, e.g. `meta-llama/llama-3.3-70b-instruct:free`.

```sh
OPENAI_API_KEY=sk-or-v1-...
OPENAI_BASE_URL=https://openrouter.ai/api/v1
```

### Option C — Google AI Studio (free tier, no card)

1. <https://aistudio.google.com/apikey> → **Create API key**.
2. Google exposes an OpenAI-compatible endpoint, so no code changes are needed:

```sh
OPENAI_API_KEY=AIza...
OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
LLM_MAIN_MODEL=gemini-2.0-flash
```

### Option D — Ollama (fully local, no key, no network at all)

```sh
brew install ollama        # or: winget install Ollama.Ollama
ollama pull llama3.1:8b
ollama serve
```

```sh
OPENAI_API_KEY=ollama      # any non-empty string; the client requires one
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
LLM_MAIN_MODEL=llama3.1:8b
LLM_CHEAP_MODEL=llama3.1:8b
```

This is the best option for a **demo video**: no network, no rate limit, no key on screen.

### Option E — Modal

Modal is a compute platform rather than a model provider, so it needs a small vLLM/TGI deployment
that exposes an OpenAI-shaped `/v1`. If you have a Modal account: deploy any vLLM example, then set
`OPENAI_BASE_URL=https://<your-app>.modal.run/v1`. Tell me if you want me to write the Modal app;
it is about 20 lines and I can put it in `infra/modal/`.

---

## 3. 🟡 Render — for the hosted demo URL

**Why it matters.** Devpost requires a working URL a judge can click, and the demo video needs one.
`render.yaml` is already written; it needs an account and a region.

1. <https://render.com> → sign up (GitHub login is easiest) → you are on the free tier.
2. Confirm **Singapore** exists for _all three_ service types (web, worker, Postgres). `render.yaml`
   pins `region: singapore` for the database and web service. If Singapore is unavailable on the
   free tier for any of them, tell me and I will switch the blueprint — this is the one
   unverified assumption in the file.
3. Push the repo to GitHub first (section 4), then **New → Blueprint** → pick the repo.
4. Render asks for the `sync: false` secrets. Paste `VI_KEK` and `GATE_SIGNING_KEY` **from
   `.env.local`**, plus the PayPal values from section 1.
5. On the deployed URL, set `PUBLIC_BASE_URL` to it exactly (it is baked into evidence packets and
   the QR code), then register the PayPal webhook against
   `https://<that-url>/api/webhooks/paypal`.

---

## 4. 🟡 GitHub remote — so CI actually runs

**Why it matters.** CI has **never executed** on this project. It is written, and it would have
caught the edge-case-ledger failure I found by hand.

1. <https://github.com/new> → name it `countersign` → **Private** → create.
2. Do **not** initialise with a README (the repo already has history).
3. Copy the remote URL and tell me — I will run:

```sh
git remote add origin <url>
git push -u origin main
git push origin --all
```

I need you to authenticate the first push (browser or a Personal Access Token with `repo` +
`workflow` scopes). Secrets are not needed for CI — it runs `pnpm test`, `pnpm lint`, `pnpm build`
and `pnpm secret-scan`, all of which pass without credentials.

---

## 5. ⚪ Bryntum trial — the dispute timeline

**Why it matters.** S-17's Gantt timeline is a `Best Use of Bryntum` prize category. There is a
plain-table fallback (`FEATURE_BRYNTUM=false`), so nothing is blocked.

1. <https://www.bryntum.com> → **Trial** → request a Gantt/Scheduler trial licence.
2. It arrives by email as a `bryntum-licence.json` or a `Bryntum...` package token.
3. Give it to me and I will wire it behind `FEATURE_BRYNTUM=true` — the flag already exists and the
   fallback is tested.

---

## 6. ⚪ Sentry — optional, skip unless you want it

`SENTRY_DSN=` is already in `.env.local` and blank. Leave it blank; `§8.19`'s logging is pino JSON to
stdout, which is what Render captures.

---

## Quick reference

| Variable                                      | Who provides it              | Section |
| --------------------------------------------- | ---------------------------- | ------- |
| `SESSION_SECRET`                              | generated ✅                 | —       |
| `VI_SERVICE_TOKEN`, `VI_KEK`                  | generated ✅                 | —       |
| `GATE_SIGNING_KEY` (Ed25519)                  | generated ✅                 | —       |
| `DATABASE_URL`                                | `docker compose up -d db` ✅ | —       |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`    | **you** 🔴                   | 1c      |
| `PAYPAL_WEBHOOK_ID`                           | **you** 🔴                   | 1e      |
| `PAYPAL_BUYER_EMAIL`, `PAYPAL_BUYER_PASSWORD` | **you** 🔴                   | 1f      |
| `PAYPAL_MERCHANT_ID`                          | **you** 🔴                   | 1f      |
| `PAYPAL_TEST_BUYER_TRANSACTION_ID`            | filled from a real capture   | 1f      |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`           | **you** 🔴 (free)            | 2       |
| Render secrets                                | **you** 🟡                   | 3       |
| Bryntum licence                               | **you** ⚪                   | 5       |

**How to hand them over:** edit `.env.local` directly, then tell me "done". I never need to see a
value — I read them from the process environment, and `git check-ignore` proves the file cannot be
committed. Do not paste secrets into this chat.
