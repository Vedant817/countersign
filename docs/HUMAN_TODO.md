# HUMAN TODO — only Vedant can do these

_Last updated: 2026-10-04_

Agents keep working on everything that is not blocked by one of these. Newest request goes at the top
of the list. When you complete an item, move it to `docs/DONE_BY_HUMAN.md` with the date.

---

## H-01 — PayPal developer + sandbox accounts, REST app, Vault enabled

**Blocks:** WP-06s (week-1 checks C1/C2), WP-07, WP-11, WP-15e, WP-20, and the whole live demo.
**Needed by:** the moment you can, ideally today.

Do exactly what spec §10.1 says:

1. Log in at <https://developer.paypal.com> → Dashboard → **Sandbox → Accounts**.
   - Two accounts are auto-created: a **Business** (merchant) and a **Personal** (buyer).
   - Create **two more Personal** accounts whose emails contain `allowappeal` and `noappeal`
     (needed for the appeal tests, spec §10.1 step 1 / [V3, S29]).
   - Set **country = US** for all four.
2. **Create the REST app**: Dashboard → **Apps & Credentials → Sandbox → Create App**,
   name `countersign-sandbox`, linked to the Business account. Copy **Client ID** and **Secret**.
3. **Enable Vault** ("Save payment methods") in the app's features. The setting name varies by
   dashboard revision — screenshot it into `docs/sandbox-setup.md`.
4. **Fund the buyer** Personal account (add a balance / confirm a linked card). The sandbox card is
   what makes the `process-chargeback` path work (§10.1 step 5, [S29]).

**Then give an agent:**

```
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_BUYER_EMAIL=<buyer personal account>
PAYPAL_BUYER_PASSWORD=...
PAYPAL_MERCHANT_EMAIL=<business account>
PAYPAL_ALLOWAPPEAL_EMAIL=<personal account with allowappeal>
PAYPAL_NOAPPEAL_EMAIL=<personal account with noappeal>
```

Put them in a git-ignored `.env.local` (never in a tracked file). An agent will create
`docs/sandbox-setup.md` and wire `.env.example` — you only paste the secrets.

---

## H-02 — OpenAI API key

**Blocks:** WP-08 (intent compiler), WP-13 (shopping agent), WP-15c (notes drafter), WP-16 (strategist).

```
OPENAI_API_KEY=sk-...
```

Also confirm the two models in spec §4 exist for your account: `gpt-6.1-sol` (main) and
`gpt-6-luna` (cheap). If your key cannot reach one of them, say so and an agent will record the
substitution in `docs/DECISIONS.md`.

---

## H-03 — Render account + credits

**Blocks:** deployment (spec D20), webhook registration (§10.1 step 4), public demo URL.

1. Create a Render account, apply the hackathon credits (spec §16 Day 1).
2. Create three **Starter** web services (`web`, `vi`, `worker`) and one **paid** Postgres
   (`basic-256mb`) — free Postgres expires after 30 days and would kill the demo mid-judging (D11).
3. Confirm a **Singapore** region exists for all three service types (spec U8).

`render.yaml` is committed by WP-00; the deploy itself just needs the account.

---

## H-04 — GitHub repo + remote

**Blocks:** pushing, CI runs, the Devpost submission link.

Create a **public** repo `countersign` with an **Apache-2.0** licence, then give an agent the remote:

```
git remote add origin git@github.com:<you>/countersign.git
```

Until this exists, everything is committed locally only (see AGENTS.md rule 7).

---

## H-05 — Bryntum trial licence for the judging period (spec U7)

**Blocks:** WP-17e's real timeline; the "Best Use of Bryntum" prize category.

Ask on the Bryntum Discord/forum whether a trial licence is valid for a hackathon + judging period
(2–15 Dec) and how to authenticate the npm registry (`BRYNTUM_NPM_TOKEN`).
**Fallback already planned:** the disputes screen has a plain-table timeline when
`FEATURE_BRYNTUM=false` (spec §9 S-17), so nothing is blocked.

---

## H-06 — Devpost prize opt-ins and submission (spec U9, §20)

**Blocks:** the actual submission, not the build.

Confirm whether **"Best Use of PayPal + AI"** can be selected alongside Grand Prize /
Best Use of Agentic Commerce / Best Use of Bryntum. Submission target: **Wed 11 Nov, 11:59 PM IST**
(hard deadline Fri 13 Nov, 1:30 AM IST).

---

## H-07 — Any login, 2FA or captcha

PayPal dashboard navigation, Render dashboard, GitHub org settings, Devpost submission, and the
PayPal buyer popup during the onboarding E2E test may all hit 2FA or a captcha. When an agent hits
one, it will add the exact request to the top of this file and continue with everything else.

---

## Not blocked, tracking anyway

- Vault "Save without purchase" JS SDK v6 needs a real browser popup (Playwright, Chromium) — an
  agent drives it, but the sandbox buyer login may need your 2FA (see H-07).
- The demo video (spec §19) is recorded by a human; WP-22 produces the shot list and captions.