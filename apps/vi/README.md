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

## Licence note

The Verifiable Intent reference implementation is Apache-2.0, which is why this project is
Apache-2.0 (spec D22, [B1]).
https://github.com/agent-intent/verifiable-intent/tree/356c29635f1c44df7de02edb58699ca9f29bece6