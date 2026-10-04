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

## H-08 — Ask upstream Verifiable Intent for a clock override on `verify_chain`

**Blocks:** full closure of **EC-TIME-3** (verify "as of capture time"). Everything else proceeds.

The Dispute Defender is supposed to re-verify a chain **as it stood at capture time**, not only now,
because a mandate that expired after the purchase must still be evidence that the purchase was
authorised. At the pinned commit `verify_chain` hardcodes `now = int(time.time())` with no parameter
to override it, so this cannot be done honestly today.

Our service therefore returns the real verdict **at `now`** plus
`at_time_not_honoured: true` and the reason, rather than fabricating an as-of answer — see
`docs/DECISIONS.md` D-009. We would rather ship a flagged gap than an unverifiable claim in a packet
we file with PayPal.

**What to ask for** (Discord / an issue on
<https://github.com/agent-intent/verifiable-intent>):

> `verify_chain` needs an optional `at_time: int | None = None` parameter that replaces
> `now = int(time.time())` when computing `exp` / `iat` validity, passed through to
> `_is_expired` and `_is_future_dated`. Without it a signed chain cannot be verified as of a past
> moment, which blocks dispute evidence for mandates that expired after the purchase.

**Interim behaviour if upstream says no or does not respond:** keep the flag, show it in the S-18
Defender workspace as "verified now; as-of-capture verification unavailable with the pinned library",
and say so in the README's honest-limits section. No code change needed — only copy.

---

## H-09 — PayPal dispute-simulator scopes + buyer consent (blocks WP-06s C1, WP-15e)

**Blocks:** `POST /v1/customer/disputes` (the buyer-dispute simulator) and `change-reason`, i.e.
week-1 check C1 and the Defender's sandbox demo path. Everything else in `packages/paypal` is verified
against PayPal's published OpenAPI; only these two need a human at the PayPal dashboard.

From the PayPal account manager, on the `countersign-sandbox` REST app (H-01 step 2):

1. Enable the **Disputes** product and grant two scopes. Both are required and neither is
   self-served:
   - `https://uri.paypal.com/services/disputes/create` (`DISPUTE_CREATE`)
   - `https://uri.paypal.com/services/disputes/update-buyer` (`UPDATE_BUYER`)
2. Complete one interactive **"Log in with PayPal"** consent flow with the sandbox buyer
   (`PAYPAL_BUYER_EMAIL`). The simulator asserts the buyer with an _unsigned_ `PayPal-Auth-Assertion`,
   but the consent step still has to happen once by hand — a script cannot skip it.
3. Note the **merchant id** of the Business account (Dashboard → account details) and the
   **seller-side transaction id** from the business account's activity. Both are now required inputs
   to `sandbox.processChargeback` (`merchant_id`, `transaction.id_enc`); the client cannot infer either.
4. Note the **buyer-side transaction id** for the same capture. `POST /v1/customer/disputes` takes
   `disputed_transactions[].buyer_transaction_id`, which is the id from the _buyer's_ view of the
   transaction, not the merchant's capture id. A capture id alone cannot simulate a dispute.

**Then give an agent** (in a git-ignored `.env.local`, never a tracked file):

```
PAYPAL_MERCHANT_ID=<9-…>
PAYPAL_TEST_BUYER_TRANSACTION_ID=<id from the buyer's activity>
PAYPAL_DISPUTE_CREATE_SCOPE_CONFIRMED=true
PAYPAL_DISPUTE_UPDATE_BUYER_SCOPE_CONFIRMED=true
PAYPAL_BUYER_CONSENT_DONE=true
```

---

## H-10 — Ask PayPal: which `PayPal-Request-Id` length is actually enforced?

**Blocks:** nothing today. Becomes a double-capture bug the moment PayPal enforces it.
**Needed by:** before the live demo (spec §19).

PayPal contradicts itself and only a probe or an answer settles it:

- the OpenAPI (`components.parameters.paypal_request_id`) declares **`maxLength: 10000`**;
- <https://developer.paypal.com/api/rest/reference/idempotency> says _"PayPal recommends that you use
  the UUID standard … because it meets the **38 single-byte character limit**."_

Our worst case is **55 characters** (`cs:{authId}:cap:{shipmentId}`), and **four of our five** formats
already exceed 38 — not just the capture one. `captureRequestId` is the one to look at first because
its long slots are PayPal's own 17-character authorization and capture ids, so it cannot be shortened
the way our ULID slots could. Spec §8.6 fixes the four formats, so changing one is a spec-level
decision (record it in `docs/DECISIONS.md`).

**Question to paste** (<https://developer.paypal.com/support> or
<https://forums.developer.paypal.com/>):

> For the `PayPal-Request-Id` header, is the enforced maximum length **38 characters** (as the
> idempotency reference page states) or **10 000** (as `maxLength` in the API reference schema)? Do
> non-UUID values longer than 38 characters get rejected? Is the limit per API or global?

**Interim behaviour if PayPal does not answer:** `REQUEST_ID_MAX_CHARS = 255` remains _our own_ budget
and is labelled as such. The C-probe settles it empirically in one experiment — send 38, 39 and 10 001
characters to `POST /v2/payments/authorizations/{id}/capture` and record which are accepted.
`packages/paypal/IDEMPOTENCY.md` → "Header length" has the recipe.

---

## Not blocked, tracking anyway

- **`domains[]` for `getClientToken`** needs the deployed Render origins, so it depends on H-03.
- **`RISK.DISPUTE.CREATED`** is a real documented PayPal event worth knowing about: it is the earliest
  signal that a dispute exists, which would give the Defender lead time instead of waiting for the
  2-minute dispute reconciler. Not currently subscribed (spec §8.12).

- Vault "Save without purchase" JS SDK v6 needs a real browser popup (Playwright, Chromium) — an
  agent drives it, but the sandbox buyer login may need your 2FA (see H-07).
- The demo video (spec §19) is recorded by a human; WP-22 produces the shot list and captions.
