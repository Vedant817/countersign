"""
The `apps/vi` half of the live end-to-end proof for `packages/gate`.

Drives **every signing route over HTTP** and keeps the service listening so the Gate can be driven against
it. This exists because of the `l1: ''` / `l2: ''` defect: `check4ChainVerify` sent an empty chain, the
`ViClient` refused it **client-side** with `CS_VALIDATION`, and 0 fetches went out. Nothing in the repository
could observe that, because every gate test injected a stub `verify`. So the proof needs a real service on
a real socket.

Route order — each one is the input the next requires:

    POST /v1/keys/agent      the agent's P-256 key (apps/web may hold only the public half)
    POST /v1/l1/issue        the issuer signs L1, binding sub + device key + card_id
    POST /v1/l2/prepare      phase 1 of two-phase signing; returns the signing_input and payload
    POST /v1/l2/finalize     phase 2; vi checks the device signature against the L1's key
    POST /v1/checkout-jwt    the merchant's price lock
    POST /v1/l3/create       pre-checks the L2's constraints, then signs L3a + L3b
    POST /v1/verify          verify_chain + check_constraints(STRICT)

The device key here is a `cryptography` P-256 key standing in for the browser's non-extractable
WebCrypto key: it signs ASCII bytes of `signing_input` and produces the raw 64-byte r||s signature
(P1363), which is exactly what `crypto.subtle.sign` returns for ES256.

Two constraints are deliberately **network-enforced** — `mandate.payment.budget` and
`mandate.payment.recurrence`. The pinned `verifiable_intent` library appends them to `checked` and
evaluates neither, so `apps/vi` must move them to `constraints.skipped` (spec D19). That is the
obligation the Gate has to discharge, and it cannot exist unless this run produced it.

Prints one line: `@@CHAIN@@` followed by the whole chain as JSON. Then blocks, serving uvicorn, so the
Node side can run the Gate against this exact process.

Run by `test/support/live-vi-proof.ts`; not intended to be run by hand.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import sys
import threading
import time
from datetime import date, timedelta
from typing import Any

# `apps/vi/src`, so `vi_service` imports whether or not the package is installed into the venv.
_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(_REPO, "apps", "vi", "src"))

# The environment `apps/vi/tests/conftest.py` sets. It must exist before `vi_service.config` reads it.
os.environ["VI_SERVICE_TOKEN"] = "live-gate-proof-service-token"
os.environ["VI_KEK"] = base64.b64encode(bytes(range(32))).decode("ascii")
os.environ["VI_ISSUER_KID"] = "issuer-key-1"
os.environ["VI_MERCHANT_KID"] = "merchant-key-1"
# The two signer identities, required since the defaults were removed. `.test` matches
# `apps/vi/tests/conftest.py`; a `.example` host is refused on boot because it can never resolve.
os.environ["VI_ISSUER_URL"] = "https://issuer.countersign.test"
os.environ["VI_AGENT_ISS"] = "https://agent.countersign.test"
os.environ["VI_CLOCK_SKEW_SECONDS"] = "300"
os.environ["VI_PREPARE_TTL_SECONDS"] = "300"
os.environ["VI_PUBLIC_RATE_LIMIT_PER_MIN"] = "1000"
os.environ["APP_ENV"] = "live-gate-proof"

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from verifiable_intent.crypto.signing import (  # noqa: E402
    es256_sign,
    generate_es256_key,
    public_key_to_jwk,
)

from vi_service import config, keys, l2, ratelimit  # noqa: E402
from vi_service.keys import b64u_encode  # noqa: E402
from vi_service.main import app  # noqa: E402

MERCHANT = {
    "id": "mrc_northwind",
    "name": "Northwind Outfitters",
    "website": "https://northwind.countersign.test",
}
ITEM = {"id": "SKU-TRAIL-42", "title": "Trail Runner"}
AGENT_ID = "agt_live_proof_agent"
USER_ID = "usr_live_proof_user"
DEVICE_KID = "dev_key_live_1"

# $30.00 exactly: the cart QA-gate-1 used, so the numbers are comparable.
UNIT_MINOR = 2_500
SHIPPING_MINOR = 300
TAX_MINOR = 200
TOTAL_MINOR = UNIT_MINOR + SHIPPING_MINOR + TAX_MINOR
CURRENCY = "USD"
AMOUNT_RANGE_MAX = 20_000  # $200.00 — what vi itself evaluates, so this one is not network-enforced
SIGNED_BUDGET_MAX = 13_000  # $130.00 — the ceiling the Gate has to read out of `disclosed.l2`

_TODAY = date.today()
START_DATE = (_TODAY - timedelta(days=365)).isoformat()
END_DATE = (_TODAY + timedelta(days=365)).isoformat()


def _free_port() -> int:
    """A free port, so two proofs can run at once without colliding."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def main() -> None:  # noqa: C901 - a linear script is clearer than a state machine here
    config.reset_settings()
    keys.reset_keystore()
    l2.reset_prepare_store()
    ratelimit.reset_limiter()
    config.set_clock(None)  # the real wall clock: the live tokens carry wall-clock iat/exp

    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    )
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 30
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("uvicorn did not start within 30s")
        time.sleep(0.02)

    base_url = f"http://127.0.0.1:{port}"
    headers = {"Authorization": f"Bearer {os.environ['VI_SERVICE_TOKEN']}"}
    device_private = generate_es256_key()
    device_public = public_key_to_jwk(device_private)

    with httpx.Client(base_url=base_url, headers=headers, timeout=30.0) as client:

        def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
            response = client.post(path, json=body)
            if response.status_code != 200:
                raise RuntimeError(f"{path} -> {response.status_code}: {response.text}")
            return dict(response.json())

        agent = post("/v1/keys/agent", {"agent_id": AGENT_ID})

        l1 = post(
            "/v1/l1/issue",
            {
                "user_id": USER_ID,
                "wallet": {
                    "payer_id": "PAYERLIVE1",
                    "payer_email": "buyer@countersign.test",
                    "payment_token_id": "vault-token-live",
                },
                "device_public_jwk": device_public,
                "device_kid": DEVICE_KID,
                "ttl_days": 365,
            },
        )

        prepared = post(
            "/v1/l2/prepare",
            {
                "l1": l1["l1"],
                "device_kid": DEVICE_KID,
                "agent_public_jwk": agent["public_jwk"],
                "agent_kid": agent["kid"],
                "checkout_constraints": [
                    {"type": "mandate.checkout.allowed_merchants", "allowed": [MERCHANT]},
                    {
                        "type": "mandate.checkout.line_items",
                        "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                        "match_mode": "minimum",
                    },
                ],
                "payment_constraints": [
                    {
                        "type": "mandate.payment.amount_range",
                        "currency": CURRENCY,
                        "min": 0,
                        "max": AMOUNT_RANGE_MAX,
                    },
                    {"type": "mandate.payment.allowed_payees", "allowed": [MERCHANT]},
                    # Network-enforced: the library never evaluates a budget, so `apps/vi` must report
                    # it in `skipped`. That report is the obligation the Gate discharges (spec D19).
                    {"type": "mandate.payment.budget", "currency": CURRENCY, "max": SIGNED_BUDGET_MAX},
                    # Also network-enforced, and also the Gate's to enforce — this is QA-gate-2.
                    {
                        "type": "mandate.payment.recurrence",
                        "frequency": "MNTH",
                        "start_date": START_DATE,
                        "end_date": END_DATE,
                        "number": 12,
                    },
                ],
                "merchants": [MERCHANT],
                "acceptable_items": [ITEM],
                "payment_instrument": {
                    "type": "paypal_vault",
                    "id": l1["card_id"],
                    "description": "PayPal ... 4242",
                },
                "nonce": "nonce-live-1",
                "aud": "https://agent.countersign.test",
                "ttl_seconds": 86_400,
                "prompt_summary": "Buy one pair of trail running shoes under $200",
            },
        )

        # The browser's non-extractable key signs exactly what WebCrypto would sign.
        signature = b64u_encode(es256_sign(prepared["signing_input"].encode("ascii"), device_private))
        finalized = post(
            "/v1/l2/finalize",
            {"prepare_id": prepared["prepare_id"], "signature_b64url": signature},
        )

        checkout = post(
            "/v1/checkout-jwt",
            {
                "merchant": MERCHANT,
                "lines": [
                    {"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": UNIT_MINOR}
                ],
                "shipping_minor": SHIPPING_MINOR,
                "tax_minor": TAX_MINOR,
                "currency": CURRENCY,
                "ttl_seconds": 900,
                "checkout_id": "chk_live_proof_1",
            },
        )

        l3_request = {
            "agent_kid": agent["kid"],
            "enc_private_key_b64": agent["enc_private_key_b64"],
            "l2": finalized["l2"],
            "checkout_jwt": checkout["checkout_jwt"],
            "payment": {
                "amount_minor": TOTAL_MINOR,
                "currency": CURRENCY,
                "payee_id": MERCHANT["id"],
            },
            "aud": "https://network.countersign.test",
            "nonce": "l3-nonce-live-1",
            "agent_id": AGENT_ID,
        }
        l3 = post("/v1/l3/create", l3_request)
        # D-033/D-034: repeating creation signs a new authorisation, not a reused replay id.
        fresh_l3 = post("/v1/l3/create", l3_request)

        verify_request = {
            "l1": l1["l1"],
            "l2": finalized["l2"],
            "l3a": l3["l3a"],
            "l3b": l3["l3b"],
            "checkout_jwt": checkout["checkout_jwt"],
            "strict": True,
        }
        verify_response = post("/v1/verify", verify_request)

        chain = {
            "base_url": base_url,
            "service_token": os.environ["VI_SERVICE_TOKEN"],
            "device_kid": DEVICE_KID,
            "device_jkt": l1["device_jkt"],
            "card_id": l1["card_id"],
            "agent_id": AGENT_ID,
            "agent_kid": agent["kid"],
            "merchant_id": MERCHANT["id"],
            "sku": ITEM["id"],
            "item_title": ITEM["title"],
            "unit_minor": UNIT_MINOR,
            "shipping_minor": SHIPPING_MINOR,
            "tax_minor": TAX_MINOR,
            "total_minor": TOTAL_MINOR,
            "currency": CURRENCY,
            "signed_budget_max": SIGNED_BUDGET_MAX,
            "l1": l1["l1"],
            "l2": finalized["l2"],
            "l2_payload": prepared["payload"],
            "l3a": l3["l3a"],
            "l3b": l3["l3b"],
            "jti": l3["jti"],
            "fresh_l3a": fresh_l3["l3a"],
            "fresh_jti": fresh_l3["jti"],
            "checkout_jwt": checkout["checkout_jwt"],
            "checkout_hash": checkout["checkout_hash"],
            "verify_request": verify_request,
            "verify_response": verify_response,
            "captured_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    sys.stdout.write("@@CHAIN@@" + json.dumps(chain) + "\n")
    sys.stdout.flush()

    # Stay alive: uvicorn keeps serving until the Node side has driven the Gate against it.
    try:
        while not server.should_exit:
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
