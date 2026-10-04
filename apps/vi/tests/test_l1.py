"""Layer 1: the issuer credential, and what it binds (spec §8.3).

L1 is the root of trust. If the wrong key ends up in `cnf.jwk`, every downstream signature check is
checking the wrong thing, so these tests are mostly about *binding* rather than about the signature.
"""

from __future__ import annotations

import base64
import hashlib
import json

import pytest
from conftest import MERCHANT, USER_ID, error_body
from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures

from vi_service.l1 import L1_VCT, card_id_for


def _issue(client, auth, device_key, **overrides: object) -> dict:
    body = {
        "user_id": USER_ID,
        "wallet": {
            "payer_id": "PAYER123",
            "payer_email": "buyer@countersign.test",
            "payment_token_id": "vault-token-abc123",
        },
        "device_public_jwk": device_key.public_jwk,
        "device_kid": device_key.kid,
        "ttl_days": 365,
    }
    body.update(overrides)
    return client.post("/v1/l1/issue", json=body, headers=auth)


def test_l1_issue_returns_the_signed_credential_and_its_window(
    client, auth: dict[str, str], device_key
) -> None:
    """The response names the key that signed it and the window it is good for."""
    response = _issue(client, auth, device_key)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["issuer_kid"] == "issuer-key-1"
    assert body["exp"] - body["iat"] == 365 * 86_400
    assert body["l1"].startswith("eyJ"), "the L1 must be a compact JWS, not a JSON object"

    claims = decode_sd_jwt(body["l1"]).payload
    assert claims["iat"] == body["iat"]
    assert claims["exp"] == body["exp"]
    assert claims["sub"] == USER_ID


def test_l1_binds_the_device_public_key_it_was_given(client, auth: dict[str, str], device_key) -> None:
    """`cnf.jwk` is the whole chain's root: it is what every later signature check compares against."""
    body = _issue(client, auth, device_key).json()
    claims = decode_sd_jwt(body["l1"]).payload

    assert claims["cnf"]["jwk"]["x"] == device_key.public_jwk["x"]
    assert claims["cnf"]["jwk"]["y"] == device_key.public_jwk["y"]
    assert "d" not in claims["cnf"]["jwk"], "the L1 must never carry a private key"
    assert body["device_jkt"] == device_key.jkt


def test_l1_uses_the_pinned_vct_so_verify_chain_accepts_it(client, auth: dict[str, str], device_key) -> None:
    """`verify_chain` pins `vct` to the library's default, so L1 issuance must use the same string.

    If the two ever diverged, every chain would fail verification at the first check with an error
    that says nothing about which side moved.
    """
    claims = decode_sd_jwt(_issue(client, auth, device_key).json()["l1"]).payload
    assert claims["vct"] == L1_VCT == "https://credentials.mastercard.com/card"


def test_l1_keeps_the_vault_id_out_of_the_credential(client, auth: dict[str, str], device_key) -> None:
    """`card_id` is a hash, so the PayPal vault id never appears in an evidence packet.

    EC-PRIV-1 in miniature: an evidence packet is filed with PayPal and readable by a merchant's
    support team, so the vault id does not belong in it.
    """
    body = _issue(client, auth, device_key).json()
    claims = resolve_disclosures(decode_sd_jwt(body["l1"]))

    assert body["card_id"] == card_id_for("vault-token-abc123")
    assert len(body["card_id"]) == 64  # hex sha256
    assert claims["card_id"] == body["card_id"]
    assert "vault-token-abc123" not in body["l1"]
    assert "PAYER123" not in body["l1"]


def test_card_id_is_deterministic_so_web_can_derive_the_same_value(
    client, auth: dict[str, str], device_key
) -> None:
    """`apps/web` must compute the identical `payment_instrument.id` when it builds the L2.

    `verify_chain` fails closed when `card_id` and `payment_instrument.id` disagree, so this
    function is a contract between two services, not an internal detail.
    """
    first = _issue(client, auth, device_key).json()["card_id"]
    second = _issue(client, auth, device_key).json()["card_id"]

    assert first == second
    assert first == card_id_for("vault-token-abc123")
    assert first != card_id_for("vault-token-different")
    assert first == hashlib.sha256(b"vault-token-abc123").hexdigest()


def test_l1_email_is_selectively_disclosable(client, auth: dict[str, str], device_key) -> None:
    """The buyer's email is a disclosure, so a verifier must ask for it rather than receive it.

    That is the library's design (`create_disclosure("email", …)`) and it matters: the public verifier
    shows a chain without leaking the address it was issued to.
    """
    serialized = _issue(client, auth, device_key).json()["l1"]
    parsed = decode_sd_jwt(serialized)

    assert "email" not in parsed.payload, "email must not be an always-visible claim"
    assert "email" in resolve_disclosures(parsed)
    assert len(parsed.disclosures) == 1


@pytest.mark.parametrize("ttl_days", [0, -1, 366, 1000])
def test_l1_ttl_days_is_capped_at_365(client, auth: dict[str, str], device_key, ttl_days) -> None:
    """Spec §8.3: `ttl_days <= 365`. An L1 outliving a year would outlive the evidence retention."""
    response = _issue(client, auth, device_key, ttl_days=ttl_days)
    assert response.status_code == 400, response.text
    assert error_body(response)["code"] == "CS_VALIDATION"


def test_l1_refuses_a_private_key_in_device_public_jwk(client, auth: dict[str, str], device_key) -> None:
    """A JWK carrying `d` is refused. The browser's key is non-extractable and must stay so.

    If this were accepted, a caller could hand the service a private key and then read it back out of
    the L1 it just signed — which would also be a way to impersonate that device.
    """
    body = {
        "user_id": USER_ID,
        "wallet": {
            "payer_id": "P",
            "payer_email": "a@b.test",
            "payment_token_id": "t",
        },
        "device_public_jwk": {**device_key.public_jwk, "d": "AAAA" * 16},
        "device_kid": device_key.kid,
    }
    response = client.post("/v1/l1/issue", json=body, headers=auth)

    assert response.status_code == 400, response.text
    error = error_body(response)
    assert error["code"] == "CS_VALIDATION"
    assert "non-extractable" in error["message"]


def test_l1_refuses_a_malformed_device_public_jwk(client, auth: dict[str, str]) -> None:
    """Wrong curve, or a coordinate that is not 32 bytes, is refused before signing."""
    for bad in (
        {"kty": "EC", "crv": "P-384", "x": "AA", "y": "AA"},
        {"kty": "EC", "crv": "P-256", "x": "AAAA", "y": "AAAA"},
        {"kty": "RSA", "crv": "P-256", "x": "A" * 43, "y": "A" * 43},
    ):
        response = client.post(
            "/v1/l1/issue",
            json={
                "user_id": USER_ID,
                "wallet": {"payer_id": "P", "payer_email": "a@b.test", "payment_token_id": "t"},
                "device_public_jwk": bad,
                "device_kid": "dev_1",
            },
            headers=auth,
        )
        assert response.status_code == 400, f"{bad} -> {response.text}"
        assert error_body(response)["code"] == "CS_VALIDATION"


def test_l1_refuses_an_unknown_field_rather_than_ignoring_it(
    client, auth: dict[str, str], device_key
) -> None:
    """`extra="forbid"`: a typo'd field is an error, not a silently dropped instruction.

    The failure this prevents is a caller sending `ttl_days` as `ttlDays`, seeing a 200, and
    believing it set a one-day TTL when it set the 365-day default.
    """
    response = _issue(client, auth, device_key, ttlDays=1)
    assert response.status_code == 400, response.text
    error = error_body(response)
    assert error["code"] == "CS_VALIDATION"
    assert error["details"]["fields"][0]["loc"] == ["body", "ttlDays"]


def test_l1_never_echoes_the_wallet_secret_back(client, auth: dict[str, str], device_key) -> None:
    """`error.details` is scrubbed, so a field named like a secret cannot leak through an error."""
    response = client.post(
        "/v1/l1/issue",
        json={
            "user_id": USER_ID,
            "wallet": {
                "payer_id": "P",
                "payer_email": "a@b.test",
                "payment_token_id": "t",
                "api_key": "sk_live_x",
            },
            "device_public_jwk": device_key.public_jwk,
            "device_kid": device_key.kid,
        },
        headers=auth,
    )

    assert response.status_code == 400
    assert "sk_live_x" not in response.text


def test_l1_header_declares_the_issuer_kid(client, auth: dict[str, str], device_key) -> None:
    """The `kid` in the header is how a verifier resolves the signing key — here or months from now."""
    parsed = decode_sd_jwt(_issue(client, auth, device_key).json()["l1"])

    assert parsed.header["alg"] == "ES256"
    assert parsed.header["typ"] == "sd+jwt"
    assert parsed.header["kid"] == "issuer-key-1"


def test_two_l1s_for_the_same_device_differ_but_both_verify(client, auth: dict[str, str], device_key) -> None:
    """Each issuance is a fresh credential (the email disclosure is salted), and both are valid.

    A verifier must never assume "same user, same token" — `l1_credentials` is one row per
    device×wallet, and re-enrolment produces a new one.
    """
    first = _issue(client, auth, device_key).json()["l1"]
    second = _issue(client, auth, device_key).json()["l1"]

    assert first != second
    for serialized in (first, second):
        assert (
            client.post("/v1/verify", json={"l1": serialized, "l2": serialized}, headers=auth).json()["keys"][
                "issuer_kid"
            ]
            == "issuer-key-1"
        )


def test_l1_prepare_binds_to_the_exact_l1_serialisation(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """The L2's `sd_hash` commits to the L1's exact bytes, so an L2 cannot move between cards.

    Asserted directly on the prepared payload: `sd_hash` is base64url SHA-256 of `l1.encode('ascii')`,
    which is what `verify_chain` recomputes and fails closed on.
    """
    import hashlib

    l1 = _issue(client, auth, device_key).json()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(l1["l1"].encode("ascii")).digest()).rstrip(b"=").decode()
    )
    assert prepared["payload"]["sd_hash"] == expected
    # And the base segment of `signing_input` carries exactly that payload.
    payload_b64 = prepared["signing_input"].split(".")[1]
    assert (
        json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
        == prepared["payload"]
    )


def test_l1_issue_requires_a_bearer_token(client, device_key) -> None:
    """AT-M3.11's boundary, checked on the very first signing route."""
    response = client.post(
        "/v1/l1/issue",
        json={
            "user_id": USER_ID,
            "wallet": {"payer_id": "P", "payer_email": "a@b.test", "payment_token_id": "t"},
            "device_public_jwk": device_key.public_jwk,
            "device_kid": "dev_1",
        },
    )

    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"
    assert error_body(response)["code"] == "CS_UNAUTHENTICATED"


def test_l1_issue_reports_a_bad_payer_email_length(client, auth: dict[str, str], device_key) -> None:
    """Over-long values are refused at the edge rather than signed into a credential."""
    response = _issue(
        client,
        auth,
        device_key,
        wallet={
            "payer_id": "P",
            "payer_email": "a" * 400 + "@b.test",
            "payment_token_id": "t",
        },
    )
    assert response.status_code == 400
    assert "payer_email" in error_body(response)["details"]["fields"][0]["loc"][-1]


def test_merchant_ref_requires_the_fields_the_library_needs_on_l3a() -> None:
    """`MerchantRef` demands `id`, `name` and `website`.

    `verify_chain`'s `_validate_payment_mandate_required_fields` rejects an L3a payee missing `name`
    or `website`, so a merchant without them could not produce a valid L3 at all. Catching it at the
    L2 boundary is one round trip earlier.
    """
    from pydantic import ValidationError

    from vi_service.models import MerchantRef

    assert MerchantRef(**MERCHANT).model_dump() == MERCHANT
    for missing in ("id", "name", "website"):
        incomplete = {k: v for k, v in MERCHANT.items() if k != missing}
        with pytest.raises(ValidationError):
            MerchantRef(**incomplete)
