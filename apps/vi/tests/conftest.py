"""Shared fixtures: one environment, one key registry, one clock, and a full chain builder.

The chain builder is the important one. Tests that assemble L1/L2/L3 by hand would be testing their
own assembly, not the service, and every assertion about "does this verify" would depend on getting
five salt-bearing disclosures in the right order. So `ChainBuilder` drives the **real routes** —
`/v1/l1/issue`, `/v1/l2/prepare`, `/v1/l2/finalize`, `/v1/checkout-jwt`, `/v1/l3/create` — and a
test can then take those exact tokens to `/v1/verify`.

That means AT-M3.1 is an end-to-end test of the HTTP surface, not of the library.
"""

from __future__ import annotations

import base64
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI
from fastapi.testclient import TestClient
from verifiable_intent.crypto.signing import (
    es256_sign,
    generate_es256_key,
    private_key_to_jwk,
    public_key_to_jwk,
)

from vi_service import config, keys, l2, ratelimit
from vi_service.keys import b64u_encode

SERVICE_TOKEN = "test-service-token-do-not-use-in-prod"
KEK = base64.b64encode(bytes(range(32))).decode("ascii")

MERCHANT = {
    "id": "mrc_northwind",
    "name": "Northwind Outfitters",
    "website": "https://northwind.countersign.test",
}
ITEM = {"id": "SKU-TRAIL-42", "title": "Trail Runner"}
AGENT_ID = "agt_test_agent"
USER_ID = "usr_test_user"
DEVICE_KID = "dev_key_test_1"

#: Enough headroom for shipping and tax so the round-trip test is not accidentally an amount test.
UNIT_MINOR = 12_000
SHIPPING_MINOR = 500
TAX_MINOR = 800
TOTAL_MINOR = UNIT_MINOR + SHIPPING_MINOR + TAX_MINOR
CURRENCY = "USD"
AMOUNT_RANGE_MAX = 20_000


@pytest.fixture(autouse=True)
def _environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """A clean environment, key registry, prepare store, limiter and clock for every test."""
    monkeypatch.setenv("VI_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("VI_KEK", KEK)
    monkeypatch.setenv("VI_ISSUER_KID", "issuer-key-1")
    monkeypatch.setenv("VI_MERCHANT_KID", "merchant-key-1")
    monkeypatch.setenv("VI_CLOCK_SKEW_SECONDS", "300")
    monkeypatch.setenv("VI_PREPARE_TTL_SECONDS", "300")
    monkeypatch.setenv("VI_PUBLIC_RATE_LIMIT_PER_MIN", "30")
    monkeypatch.setenv("APP_ENV", "test")

    config.reset_settings()
    keys.reset_keystore()
    l2.reset_prepare_store()
    ratelimit.reset_limiter()
    config.set_clock(None)

    from vi_service.main import app

    yield app

    config.set_clock(None)
    config.reset_settings()
    keys.reset_keystore()
    l2.reset_prepare_store()
    ratelimit.reset_limiter()


@pytest.fixture
def client(_environment: FastAPI) -> Iterator[TestClient]:
    with TestClient(_environment) as c:
        yield c


@pytest.fixture
def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {SERVICE_TOKEN}"}


@pytest.fixture
def clock() -> config.FixedClock:
    """A clock the test moves by hand, so no test ever sleeps."""
    fixed = config.FixedClock(config.now_sec())
    config.set_clock(fixed)
    return fixed


# --- the browser's device key ------------------------------------------------------------------------


@dataclass
class DeviceKey:
    """Stands in for the browser's non-extractable WebCrypto key.

    In production the private key never exists outside the browser (spec §3.1). Here it is a
    `cryptography` key that signs exactly what WebCrypto would: ASCII bytes of `signing_input`,
    producing a raw 64-byte r‖s signature ([B4], P1363 — not DER).
    """

    kid: str
    private_key: ec.EllipticCurvePrivateKey
    jkt: str

    @property
    def public_jwk(self) -> dict[str, Any]:
        return public_key_to_jwk(self.private_key)

    def sign(self, signing_input: str) -> str:
        """base64url raw r‖s. Same bytes `crypto.subtle.sign` returns, padded the same way."""
        return b64u_encode(es256_sign(signing_input.encode("ascii"), self.private_key))

    def sign_der(self, signing_input: str) -> str:
        """A DER signature, to prove the length gate rejects the wrong encoding."""
        from cryptography.hazmat.primitives.hashes import SHA256

        der = self.private_key.sign(signing_input.encode("ascii"), ec.ECDSA(SHA256()))
        return b64u_encode(der)


@pytest.fixture
def device_key() -> DeviceKey:
    from vi_service.keys import rfc7638_thumbprint

    private_key = generate_es256_key()
    jwk = public_key_to_jwk(private_key)
    return DeviceKey(kid=DEVICE_KID, private_key=private_key, jkt=rfc7638_thumbprint(jwk))


@pytest.fixture
def wrong_key() -> DeviceKey:
    """A second, equally valid P-256 key. The one that must not be able to complete an L2."""
    from vi_service.keys import rfc7638_thumbprint

    private_key = generate_es256_key()
    jwk = public_key_to_jwk(private_key)
    return DeviceKey(kid="dev_key_impostor", private_key=private_key, jkt=rfc7638_thumbprint(jwk))


@pytest.fixture
def agent_key(client: TestClient, auth: dict[str, str]) -> AgentKey:
    """Mint a real agent key through the route, the way `apps/web` does.

    What comes back is exactly what `apps/web` is allowed to hold: the public JWK and the
    AES-256-GCM ciphertext. There is no private key here, and there must not be — that absence is
    the property the tests check.
    """
    response = client.post("/v1/keys/agent", json={"agent_id": AGENT_ID}, headers=auth)
    assert response.status_code == 200, response.text
    body = response.json()
    return AgentKey(
        kid=body["kid"],
        public_jwk=body["public_jwk"],
        enc_private_key_b64=body["enc_private_key_b64"],
    )


@dataclass
class AgentKey:
    """An agent key as `apps/web` holds it: the public JWK and the ciphertext, never the private half."""

    kid: str
    public_jwk: dict[str, Any]
    enc_private_key_b64: str


# --- constraint payloads ------------------------------------------------------------------------------


def amount_range_constraint(max_minor: int = AMOUNT_RANGE_MAX) -> dict[str, Any]:
    return {"type": "mandate.payment.amount_range", "currency": CURRENCY, "min": 0, "max": max_minor}


def budget_constraint(max_minor: int = AMOUNT_RANGE_MAX) -> dict[str, Any]:
    """Network-enforced: the library never evaluates it, so verify must report it as *skipped*."""
    return {"type": "mandate.payment.budget", "currency": CURRENCY, "max": max_minor}


def recurrence_constraint() -> dict[str, Any]:
    return {
        "type": "mandate.payment.recurrence",
        "frequency": "MNTH",
        "start_date": "2026-10-01",
        "number": 6,
    }


def allowed_payees_constraint(*merchant_ids: str) -> dict[str, Any]:
    return {
        "type": "mandate.payment.allowed_payees",
        "allowed": [MERCHANT] if merchant_ids == (MERCHANT["id"],) else [],
    }


def checkout_constraints() -> list[dict[str, Any]]:
    return [
        {"type": "mandate.checkout.allowed_merchants", "allowed": [MERCHANT]},
        {
            "type": "mandate.checkout.line_items",
            "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
            "match_mode": "minimum",
        },
    ]


def payment_constraints(max_minor: int = AMOUNT_RANGE_MAX) -> list[dict[str, Any]]:
    return [
        amount_range_constraint(max_minor),
        allowed_payees_constraint(MERCHANT["id"]),
        budget_constraint(max_minor),
        recurrence_constraint(),
    ]


# --- the chain builder --------------------------------------------------------------------------------


@dataclass
class Chain:
    """The tokens and the request bodies that produced them."""

    l1: str
    card_id: str
    device_jkt: str
    l2: str
    l2_payload: dict[str, Any]
    signing_input: str
    prepare_id: str
    checkout_jwt: str
    checkout_hash: str
    l3a: str
    l3b: str
    jti: str
    nonce: str
    agent_kid: str
    payment_presentation: str = ""
    checkout_presentation: str = ""

    def verify_body(self, **overrides: Any) -> dict[str, Any]:  # noqa: ANN401 - field overrides
        """The `POST /v1/verify` request for this chain, with optional field overrides."""
        body: dict[str, Any] = {
            "l1": self.l1,
            "l2": self.l2,
            "l3a": self.l3a,
            "l3b": self.l3b,
            "checkout_jwt": self.checkout_jwt,
            "strict": True,
        }
        body.update(overrides)
        return body


class ChainBuilder:
    """Drives the real routes to produce a complete, verifiable autonomous chain."""

    def __init__(self, client: TestClient, auth: dict[str, str], device_key: DeviceKey) -> None:
        self.client = client
        self.auth = auth
        self.device = device_key
        self.agent: AgentKey | None = None

    def issue_l1(self, *, ttl_days: int = 365) -> dict[str, Any]:
        response = self.client.post(
            "/v1/l1/issue",
            json={
                "user_id": USER_ID,
                "wallet": {
                    "payer_id": "PAYER123",
                    "payer_email": "buyer@countersign.test",
                    "payment_token_id": "vault-token-abc123",
                },
                "device_public_jwk": self.device.public_jwk,
                "device_kid": self.device.kid,
                "ttl_days": ttl_days,
            },
            headers=self.auth,
        )
        assert response.status_code == 200, response.text
        return response.json()

    def prepare_l2(
        self,
        l1: str,
        agent: AgentKey,
        *,
        payment: list[dict[str, Any]] | None = None,
        checkout: list[dict[str, Any]] | None = None,
        nonce: str | None = None,
        instrument_id: str | None = None,
        card_id: str | None = None,
    ) -> dict[str, Any]:
        response = self.client.post(
            "/v1/l2/prepare",
            json={
                "l1": l1,
                "device_kid": self.device.kid,
                "agent_public_jwk": agent.public_jwk,
                "agent_kid": agent.kid,
                "checkout_constraints": checkout if checkout is not None else checkout_constraints(),
                "payment_constraints": payment if payment is not None else payment_constraints(),
                "merchants": [MERCHANT],
                "acceptable_items": [ITEM],
                "payment_instrument": {
                    "type": "paypal_vault",
                    "id": instrument_id or card_id or "",
                    "description": "PayPal ···· 1234",
                },
                "nonce": nonce or "nonce-test-1",
                "aud": "https://agent.countersign.test",
                "ttl_seconds": 86_400,
                "prompt_summary": "Buy one pair of trail running shoes under $200",
            },
            headers=self.auth,
        )
        assert response.status_code == 200, response.text
        return response.json()

    def finalize_l2(self, prepare_id: str, signature_b64url: str) -> Any:  # noqa: ANN401 - a Response  # noqa: ANN401 - a Response
        return self.client.post(
            "/v1/l2/finalize",
            json={"prepare_id": prepare_id, "signature_b64url": signature_b64url},
            headers=self.auth,
        )

    def checkout_jwt(
        self, *, unit_minor: int = UNIT_MINOR, qty: int = 1, ttl_seconds: int = 900
    ) -> dict[str, Any]:
        response = self.client.post(
            "/v1/checkout-jwt",
            json={
                "merchant": MERCHANT,
                "lines": [{"sku": ITEM["id"], "title": ITEM["title"], "qty": qty, "unit_minor": unit_minor}],
                "shipping_minor": SHIPPING_MINOR,
                "tax_minor": TAX_MINOR,
                "currency": CURRENCY,
                "ttl_seconds": ttl_seconds,
                "checkout_id": "chk_test_1",
            },
            headers=self.auth,
        )
        assert response.status_code == 200, response.text
        return response.json()

    def create_l3(
        self,
        l2: str,
        checkout: dict[str, Any],
        agent: AgentKey,
        *,
        amount_minor: int = TOTAL_MINOR,
        currency: str = CURRENCY,
        payee_id: str | None = None,
    ) -> Any:  # noqa: ANN401 - an httpx Response
        return self.client.post(
            "/v1/l3/create",
            json={
                "agent_kid": agent.kid,
                "enc_private_key_b64": agent.enc_private_key_b64,
                "l2": l2,
                "checkout_jwt": checkout["checkout_jwt"],
                "payment": {
                    "amount_minor": amount_minor,
                    "currency": currency,
                    "payee_id": payee_id or MERCHANT["id"],
                },
                "aud": "https://network.countersign.test",
                "nonce": "l3-nonce-test-1",
                "agent_id": AGENT_ID,
            },
            headers=self.auth,
        )


@pytest.fixture
def builder(client: TestClient, auth: dict[str, str], device_key: DeviceKey) -> ChainBuilder:
    return ChainBuilder(client, auth, device_key)


@pytest.fixture
def full_chain(builder: ChainBuilder, device_key: DeviceKey, agent_key: AgentKey) -> Chain:
    """A complete chain through every signing route: L1, L2 (two-phase), price lock, L3a + L3b."""
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    assert finalized.status_code == 200, finalized.text
    checkout = builder.checkout_jwt()
    l3 = builder.create_l3(finalized.json()["l2"], checkout, agent_key)
    assert l3.status_code == 200, l3.text
    body = l3.json()
    return Chain(
        l1=l1["l1"],
        card_id=l1["card_id"],
        device_jkt=l1["device_jkt"],
        l2=finalized.json()["l2"],
        l2_payload=prepared["payload"],
        signing_input=prepared["signing_input"],
        prepare_id=prepared["prepare_id"],
        checkout_jwt=checkout["checkout_jwt"],
        checkout_hash=checkout["checkout_hash"],
        l3a=body["l3a"],
        l3b=body["l3b"],
        jti=body["jti"],
        nonce="nonce-test-1",
        agent_kid=agent_key.kid,
        payment_presentation=body["payment_presentation"],
        checkout_presentation=body["checkout_presentation"],
    )


# --- helpers ------------------------------------------------------------------------------------------


def error_body(response) -> dict[str, Any]:
    """Assert the response carries a `CsErrorBody` and return its `error` object."""
    body = response.json()
    assert set(body) == {"error"}, f"error responses must be exactly {{error: …}}, got {sorted(body)}"
    error = body["error"]
    assert set(error) <= {"code", "message", "userMessage", "retryable", "details"}, sorted(error)
    for key in ("code", "message", "userMessage", "retryable"):
        assert key in error, f"CsErrorBody is missing {key}"
    assert isinstance(error["retryable"], bool)
    return error


def private_jwk_of(key: DeviceKey) -> dict[str, Any]:
    return private_key_to_jwk(key.private_key)
