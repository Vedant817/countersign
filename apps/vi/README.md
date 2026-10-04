# `vi-service` — the crypto oracle

FastAPI wrapper around the reference **Verifiable Intent** library, pinned to commit
`356c29635f1c44df7de02edb58699ca9f29bece6` — spec **D2**, **§8.3 (M3)**, work package **WP-03**.

> "Spec-correct SD-JWT plus the KB chain is the core of our credibility; re-implementing it in TS is
> a bug farm." — spec D2

## What it does, and what it deliberately does not

The service **signs and verifies**. It is stateless except for its keys. All persistence and all
authority live in Postgres behind `apps/web`:

```
POST /v1/l1/issue         issuer key signs L1 (binds device public key + payer_id)
POST /v1/l2/prepare       build an L2 the *browser* will sign (two-phase signing, spec D3)
POST /v1/l2/finalize      verify the browser's signature, then return L2
POST /v1/checkout-jwt     merchant key signs the price-locked checkout JWT
POST /v1/l3/create        agent key signs L3a (payment) + L3b (checkout)
POST /v1/verify           verify_chain + check_constraints in StrictnessMode.STRICT
POST /v1/public/verify    public, rate-limited, for /v/{packetId}
GET  /v1/jwks             issuer, merchant and agent public keys, retired keys included
POST /v1/keys/rotate      rotate ISSUER or MERCHANT
```

Because vi-service holds no state, a browser "Sign with this device" flow works like this:

1. `POST /v1/l2/prepare` → `{prepare_id, signing_input, header, payload, expires_at}`.
   The service builds the L2 body and remembers it **in memory, keyed by `prepare_id`, for 300 s**.
2. The browser renders the **decoded `payload` returned by this service** (not its own copy, spec
   §8.5), then signs `signing_input` with a non-extractable WebCrypto key and posts the raw `r‖s`.
3. `POST /v1/l2/finalize` **verifies that signature against the L1 device key before returning L2.**
   A wrong key fails with `VI_SIGNATURE_MISMATCH` — this is what makes two-phase signing safe rather
   than a way to attach an arbitrary signature.

## Auth

Every route needs `Authorization: Bearer ${VI_SERVICE_TOKEN}` **except** `GET /v1/jwks` and
`POST /v1/public/verify`, which are public and rate-limited to 30 requests/minute per IP. The
service is on Render's private network (spec D20) and is never exposed directly.

Errors are raised as `HTTPException` with a `CsErrorBody` body, matching `packages/core`'s
`toBody()` exactly so both runtimes produce one error contract (spec §8.0 rule 3).

## Keys

| Role | Held by | At rest |
|---|---|---|
| ISSUER | vi-service | in memory, from `VI_ISSUER_KID`; public half in JWKS |
| MERCHANT (checkout) | vi-service | in memory, from `VI_MERCHANT_KID` |
| AGENT (one per agent) | vi-service | **AES-256-GCM encrypted**, key from `VI_KEK` |

`POST /v1/keys/agent` mints a P-256 key per agent instance and returns the public JWK plus the
encrypted private key; `apps/web` stores only the ciphertext in `agents.enc_private_key` (spec D5).
Per-agent keys are what give per-agent accountability: an L3 is only valid under the key its own L2
bound.

`POST /v1/keys/rotate` retires the current key rather than deleting it. Retired public keys stay in
`GET /v1/jwks` with a `status`, so evidence filed months ago still verifies (spec EC-KEY-2, EC-KEY-3).

## Run it

```bash
cd apps/vi
uv sync --extra dev
uv run uvicorn vi_service.main:app --port 8000
uv run pytest                       # AT-M3
```

Required environment: `VI_SERVICE_TOKEN`, `VI_KEK` (base64 32 bytes), `VI_ISSUER_KID`,
`VI_MERCHANT_KID`, `VI_CLOCK_SKEW_SECONDS` (default 300, the library default).

The service **refuses to start** if `VI_SERVICE_TOKEN` or `VI_KEK` is missing or if the KEK does not
decode to exactly 32 bytes (spec §6: "The process MUST refuse to start if any required variable is
missing"). Failing at boot matters: a service that starts and then 401s everything looks healthy to
the platform.

Optional, all defaulted: `VI_PREPARE_TTL_SECONDS` (300), `VI_PUBLIC_RATE_LIMIT_PER_MIN` (30),
`VI_ISSUER_URL`, `VI_AGENT_ISS`, `APP_ENV`.

## The route contracts

Amounts are **integer minor units plus a currency code, everywhere** (spec §0, §8.0 rule 9,
EC-FX-6). `amount_minor: 13000` is $130.00. A float (`13000.0`) or a formatted string (`"13000"`)
is a `CS_VALIDATION` error, never a coercion — the coercion would be a hundredfold bug.

| Route | Request | Response |
|---|---|---|
| `POST /v1/keys/agent` | `{agent_id}` | `{kid, public_jwk, enc_private_key_b64}` |
| `POST /v1/keys/rotate` | `{role: ISSUER\|MERCHANT}` | `{new_kid, role, retired_kid}` |
| `GET /v1/jwks` | — | `{keys:[…]}`, retired included, each with `status` |
| `POST /v1/l1/issue` | `{user_id, wallet:{payer_id,payer_email,payment_token_id}, device_public_jwk, device_kid, ttl_days≤365, pan_last_four, scheme}` | `{l1, iat, exp, issuer_kid, card_id, device_jkt}` |
| `POST /v1/l2/prepare` | `{l1, device_kid, agent_public_jwk, agent_kid, checkout_constraints[], payment_constraints[], merchants[], acceptable_items[], payment_instrument:{type,id,description}, nonce, aud, ttl_seconds≤2592000, prompt_summary, iss, device_id, ip_address}` | `{prepare_id, signing_input, header, payload, expires_at, prepare_ttl_seconds}` |
| `POST /v1/l2/finalize` | `{prepare_id, signature_b64url}` (raw 64-byte r‖s) | `{l2, iat, exp, agent_kid}` |
| `POST /v1/checkout-jwt` | `{merchant:{id,url→website,name}, lines:[{sku,title,qty,unit_minor}], shipping_minor, tax_minor, currency, ttl_seconds, checkout_id}` | `{checkout_jwt, checkout_hash, exp, total_minor, currency, kid}` |
| `POST /v1/l3/create` | `{agent_kid, enc_private_key_b64, l2, checkout_jwt, payment:{amount_minor,currency,payee_id}, aud, nonce, iss, ttl_seconds≤3600, agent_id}` | `{l3a, l3b, jti, iat, exp, checkout_hash, payment_presentation, checkout_presentation}` |
| `POST /v1/verify` | `{l1, l2, l3a?, l3b?, checkout_jwt?, expected_aud?, expected_nonce?, at_time?, strict}` | `{chain_valid, errors[], constraints:{satisfied,violations,checked,skipped}, disclosed:{l1,l2,l3a,l3b}, keys:{issuer_kid,device_jkt,agent_kid,device_kid,merchant_kid}, checks_performed[], checks_skipped[], verified_at, clock_skew_seconds, at_time_not_honoured, at_time_reason, at_time_check}` |
| `POST /v1/public/verify` | `{bundle:{l1,l2,l3a?,l3b?,checkout_jwt?,…}, expected_aud?, expected_nonce?, at_time?}` | the `/v1/verify` response **plus `bundle_hash`** |
| `GET /v1/status` | — | `{ok, app_env, issuer_kid, merchant_kid, clock_skew_seconds}` |
| `GET /v1/checkout-jwt/verify` | `?checkout_jwt=` | `{valid, reason, checked_at}` (diagnostic, private) |

`/openapi.json` is the schema source of truth for WP-04's drift test (spec §8.4 AT-M4.2).

### Four things worth knowing before you call this service

**1. `l2/finalize` returns the L2 *with its disclosures*.** The browser signs `header.payload`; the
disclosures (which is where the two open mandates live) are appended at finalize. A token without
them carries no mandate, and `verify_chain` says "L2 delegate_payload resolved zero mandate
disclosures".

**2. `payment_instrument.id` must equal the L1's `card_id`.** Both are lowercase hex SHA-256 of the
PayPal vault payment-token id (`vi_service.l1.card_id_for`). `verify_chain` fails closed when they
disagree, so `apps/web` must derive it the same way.

**3. `l3/create` evaluates the constraints before it signs.** The agent is the untrusted party
(spec §3.1); a route that would sign an out-of-mandate L3 would let a prompt injection in a product
listing spend money. `VI_CONSTRAINT_VIOLATION` means "not signed", and `details.violations` says why.

**4. `prompt_summary` is accepted but not signed.** `UserMandate` has the field;
`create_layer2_autonomous` at the pinned commit never serialises it. The UI must not present it as
signed content.

## Constraint reporting: `checked` vs `skipped`

The library appends `mandate.payment.budget`, `mandate.payment.recurrence` and
`mandate.payment.agent_recurrence` to `checked` while evaluating **none** of them (its own source
comment says "Network-enforced constraints"). We move them into `skipped` with that reason, because
Countersign's **Gate** enforces those three (spec D19) and the Gate has to be able to see what it
still owes (spec §8.8 [B3]). `tests/constraint_shapes.json` is the generated contract for all eight
constraint shapes, keyed by type plus a `__meta__` block naming the pinned commit.

An **empty** constraint list is reported as `satisfied: false` with "no constraints were disclosed",
never as a pass. Nothing to check is not the same as checked.

## `at_time` is accepted, and honestly reported as not honoured (EC-TIME-3)

`verify_chain` at the pinned commit takes **no clock override** — it reads `time.time()` internally
(`verification/chain.py`: `now = int(time.time())`). So `/v1/verify` cannot produce a genuine
as-of-capture-time verdict, and it does not pretend to:

```jsonc
{
  "chain_valid": true,               // the verdict at `now`
  "verified_at": 1790000000,
  "at_time_not_honoured": true,
  "at_time_reason": "verify_chain() at the pinned commit 356c296 has no clock override: …",
  "at_time_check": {
    "requested": 1790000000,
    "honoured": false,              // always false while the library has no `now` parameter
    "within_validity_at": false,    // ADVISORY: our own iat/exp window check, not a chain verdict
    "within_validity_now": true,
    "l1_exp": 1790600000, "l2_exp": 1790003600
  }
}
```

A fabricated as-of verdict would be worse than none: it would end up in an evidence packet filed
with PayPal. Making the library honour `at_time` needs a `now` parameter upstream — see
`docs/HUMAN_TODO.md`.

## `bundle_hash` and JCS

`bundle_hash` is base64url SHA-256 over the RFC 8785 (JCS) canonical form of the bundle — the same
value the Gate writes into `evidence_packets.bundle_hash` and the PayPal order's `custom_id`
(`"cs1:" + this`, spec §7.3). Our JCS is keys-sorted, whitespace-free, and **refuses floats**: a
float would make the hash depend on a number-formatting decision, and this service has no floats
because money is integer minor units. One is rejected with `CS_VALIDATION` rather than serialised
in a way that might not match the TypeScript side.

## Money, in one place

| Where | How |
|---|---|
| `amount_minor`, `unit_minor`, `shipping_minor`, `tax_minor` | `int`, pydantic `strict=True` |
| `currency` | one of USD EUR GBP INR JPY AUD CAD; `'usd'` is **rejected**, not lower-cased |
| checkout JWT payload | `unit_minor` / `amount_minor` + `currency_code`. No `unitPrice`, no floats |
| `card_id`, `payment_instrument.id` | lowercase hex SHA-256 |
| `checkout_hash`, `jti`, `bundle_hash` | base64url SHA-256, unpadded |

`tests/test_checkout_jwt.py::test_EC_FX_6_every_amount_in_the_price_lock_is_an_integer` walks the
whole decoded payload asserting no leaf is a `float`.

## The prepare store

`prepare_id → record`, in memory, TTL 300 s (§8.3). It is a **capability**, not state: it authorises
exactly one signature over one specific byte string for a bounded time. Consequences:

* expiry is enforced by *removal*, not a timestamp comparison at read time, so a lapsed record does
  not linger in a heap dump;
* losing the store on restart is safe — the browser asks `prepare` again, which is idempotent
  (§8.4: "`l2/prepare` … is safe to repeat");
* finalize is repeatable inside the window, and re-verifies the signature every time.

## Errors

One contract, matching `packages/core`'s `toBody()`:

```json
{"error": {"code": "…", "message": "…", "userMessage": "…", "retryable": false, "details": {…}}}
```

FastAPI's own 422 is converted, so a client never has to branch on which layer produced the error.
`details` is scrubbed — anything whose key looks like `token`, `secret`, `credential`, `private`,
`api_key` or `*_key` never crosses the trust boundary.

`POST /v1/verify` **never** 4xxes on an invalid chain: it returns `200` with `chain_valid: false`
and reason strings. Only a malformed *request* is a 4xx.

Rate limiting uses `CS_CONFLICT` with HTTP 429 and `Retry-After`, because `CS_ERROR_CODES` has no
rate-limit code and `PP_RATE_LIMITED` would tell a buyer PayPal is throttling us.

## Testing

```bash
uv run pytest                       # 181 tests: AT-M3.1 … AT-M3.11
uv run pytest tests/test_constraints_fixture.py   # regenerate constraint_shapes.json
uvx ruff check src tests            # ruff is not in [dev]; see below
```

`ChainBuilder` in `tests/conftest.py` drives the **real routes** to produce a chain, so "does this
verify" is a statement about the service rather than about a test helper's assembly.

`ruff` is not in the `dev` extra, so `uv run ruff` cannot resolve a binary; use `uvx ruff`
(0.16.10). `ruff check src tests` is clean except `ANN001` on pytest fixture parameters, which wants

```toml
[tool.ruff.lint.per-file-ignores]
"tests/*" = ["ANN001"]
```

in `apps/vi/pyproject.toml` — the file's own owner, not this package's.

## Licence note

The Verifiable Intent reference implementation is Apache-2.0, which is why this project is
Apache-2.0 (spec D22, [B1]).
https://github.com/agent-intent/verifiable-intent/tree/356c29635f1c44df7de02edb58699ca9f29bece6