"""The merchant price lock (spec §8.3, EC-FX-6).

Ported from `examples/helpers.py::create_checkout_jwt` with the one change the spec names:
**integer minor units, never float dollars**. Most of this file exists to prove that change is real
rather than cosmetic, because the reference implementation divides by 100 and calls it a day.
"""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Iterator

import pytest
from conftest import CURRENCY, ITEM, MERCHANT, TAX_MINOR, UNIT_MINOR, error_body

from vi_service.checkout_jwt import (
    checkout_hash_from_jwt,
    decode_checkout_jwt_header,
    decode_checkout_jwt_payload,
    verify_checkout_signature,
)


def _create(client, auth, **overrides: object) -> dict:
    body = {
        "merchant": MERCHANT,
        "lines": [{"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": UNIT_MINOR}],
        "shipping_minor": 500,
        "tax_minor": TAX_MINOR,
        "currency": CURRENCY,
        "ttl_seconds": 900,
        "checkout_id": "chk_test_1",
    }
    body.update(overrides)
    return client.post("/v1/checkout-jwt", json=body, headers=auth)


def test_checkout_jwt_is_signed_by_the_merchant_key(client, auth: dict[str, str]) -> None:
    """`iss` is our merchant URL and the header names the merchant key."""
    body = _create(client, auth).json()

    header = decode_checkout_jwt_header(body["checkout_jwt"])
    assert header == {"alg": "ES256", "typ": "JWT", "kid": "merchant-key-1"}

    payload = decode_checkout_jwt_payload(body["checkout_jwt"])
    assert payload["iss"] == MERCHANT["website"]
    assert payload["sub"] == "cart_checkout"
    assert payload["merchant"] == MERCHANT
    assert payload["checkout_id"] == "chk_test_1"

    valid, reason = verify_checkout_signature(body["checkout_jwt"])
    assert valid is True, reason


def test_EC_FX_6_every_amount_in_the_price_lock_is_an_integer(client, auth: dict[str, str]) -> None:
    """EC-FX-6 — no float dollars anywhere in the signed payload.

    This is the whole point of the port. The reference helper writes
    ``"unitPrice": cents / 100``; we write ``unit_minor`` and let the edge render it. The assertion
    walks the decoded payload rather than spot-checking fields, because a float can hide in a nested
    dict just as easily as a top-level one.
    """
    payload = decode_checkout_jwt_payload(_create(client, auth).json()["checkout_jwt"])
    cart = payload["cart"]

    assert cart["subtotal"] == {"amount_minor": UNIT_MINOR, "currency_code": CURRENCY}
    assert cart["shipping"] == {"amount_minor": 500, "currency_code": CURRENCY}
    assert cart["tax"] == {"amount_minor": TAX_MINOR, "currency_code": CURRENCY}
    assert cart["total"] == {"amount_minor": UNIT_MINOR + 500 + TAX_MINOR, "currency_code": CURRENCY}

    item = cart["items"][0]
    assert item == {
        "sku": ITEM["id"],
        "title": ITEM["title"],
        "quantity": 1,
        "unit_minor": UNIT_MINOR,
        "line_minor": UNIT_MINOR,
    }
    assert "unitPrice" not in item, "the reference's float field must not survive the port"

    for _path, value in _walk(payload):
        assert not isinstance(value, float), f"a float reached the signed price lock: {value!r}"


def test_EC_FX_6_arithmetic_is_exact_for_prices_that_do_not_divide_by_100(
    client, auth: dict[str, str]
) -> None:
    """The case where float dollars actually lose money.

    `qty * unit_minor` in a float is exact for these values in IEEE-754 double, but the *rendered*
    dollar amount is not, and the reference divides by 100 as it goes. We keep integers end to end, so
    the only place rounding can happen is the UI.
    """
    body = _create(
        client,
        auth,
        lines=[
            {"sku": "SKU-A", "title": "A", "qty": 3, "unit_minor": 3_333},
            {"sku": "SKU-B", "title": "B", "qty": 7, "unit_minor": 1_117},
        ],
        shipping_minor=999,
        tax_minor=1,
    ).json()

    cart = decode_checkout_jwt_payload(body["checkout_jwt"])["cart"]
    assert cart["subtotal"]["amount_minor"] == 3 * 3_333 + 7 * 1_117 == 17_818
    assert cart["total"]["amount_minor"] == 17_818 + 999 + 1
    assert body["total_minor"] == 18_818
    assert isinstance(body["total_minor"], int)


def test_zero_and_large_quantities_stay_integers(client, auth: dict[str, str]) -> None:
    """Quantity is bounded and the total is an `int` all the way to the response."""
    body = _create(
        client,
        auth,
        lines=[{"sku": "SKU-A", "title": "A", "qty": 1000, "unit_minor": 0}],
        shipping_minor=0,
        tax_minor=0,
    ).json()

    assert body["total_minor"] == 0
    assert body["currency"] == CURRENCY
    cart = decode_checkout_jwt_payload(body["checkout_jwt"])["cart"]
    assert cart["items"][0]["line_minor"] == 0
    assert isinstance(cart["total"]["amount_minor"], int)


def test_the_hash_is_base64url_sha256_of_the_ascii_jwt_bytes(client, auth: dict[str, str]) -> None:
    """`checkout_hash` must agree byte-for-byte with what `issuance/user.py` recomputes.

    That function computes `_b64url_encode(sha256(checkout_jwt.encode("ascii")).digest())`. If ours
    differed by a byte, the L2's `transaction_id` binding would fail with a mismatch that reads like
    tampering — and there would be nothing in the logs to explain it.
    """
    body = _create(client, auth).json()
    jwt = body["checkout_jwt"]

    expected = base64.urlsafe_b64encode(hashlib.sha256(jwt.encode("ascii")).digest()).rstrip(b"=").decode()
    assert body["checkout_hash"] == expected == checkout_hash_from_jwt(jwt)
    assert len(expected) == 43  # 32 bytes, base64url, unpadded

    # And the library's own integrity check agrees.
    from verifiable_intent.verification.integrity import verify_checkout_hash_binding

    ok, error = verify_checkout_hash_binding(
        {"checkout_jwt": jwt, "checkout_hash": body["checkout_hash"]},
        {"transaction_id": body["checkout_hash"]},
    )
    assert ok is True, error


def test_hash_rejects_a_non_ascii_jwt_rather_than_disagreeing_with_the_library(
    client, auth: dict[str, str]
) -> None:
    """A JWT containing a non-ASCII byte raises instead of hashing UTF-8 and quietly diverging.

    `examples/helpers.py` uses `.encode("utf-8")`; `issuance/user.py` uses `.encode("ascii")`. For a
    real JWS the two are identical, but relying on that silently would be a latent mismatch, so we
    make it loud.
    """
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        checkout_hash_from_jwt("héader.payload.signature")
    assert excinfo.value.status_code == 400
    assert "ASCII" in excinfo.value.detail["error"]["message"]


def test_the_price_lock_expires_when_asked(client, auth: dict[str, str]) -> None:
    """The window is the caller's, bounded, and reported."""
    body = _create(client, auth, ttl_seconds=900).json()
    payload = decode_checkout_jwt_payload(body["checkout_jwt"])

    assert payload["exp"] - payload["iat"] == 900
    assert body["exp"] == payload["exp"]


@pytest.mark.parametrize("ttl", [0, 29, 86_401, 10**9])
def test_price_lock_ttl_is_bounded(client, auth: dict[str, str], ttl) -> None:
    """A lock must be short-lived: 15 minutes is the product default (`CHECKOUT_PRICE_LOCK_SECONDS`)."""
    assert _create(client, auth, ttl_seconds=ttl).status_code == 400


@pytest.mark.parametrize("bad", [12000.0, "12000", None, -1, True])
def test_unit_minor_refuses_floats_and_numeric_strings(client, auth: dict[str, str], bad) -> None:
    """The money rule at the outermost edge, before any arithmetic happens."""
    response = _create(client, auth, lines=[{"sku": "SKU-A", "title": "A", "qty": 1, "unit_minor": bad}])
    assert response.status_code == 400, f"{bad!r} -> {response.text}"
    error = error_body(response)
    assert error["code"] == "CS_VALIDATION"
    assert error["details"]["fields"][0]["loc"][-1] == "unit_minor"


def test_quantity_must_be_a_positive_integer(client, auth: dict[str, str]) -> None:
    """Zero, negative and fractional quantities are all refused."""
    for bad in (0, -3, 1.5, "1", True):
        response = _create(
            client, auth, lines=[{"sku": "SKU-A", "title": "A", "qty": bad, "unit_minor": 100}]
        )
        assert response.status_code == 400, f"{bad!r} -> {response.text}"
        assert error_body(response)["details"]["fields"][0]["loc"][-1] == "qty"


def test_lines_must_be_non_empty(client, auth: dict[str, str]) -> None:
    """A price lock with no lines locks no price."""
    assert _create(client, auth, lines=[]).status_code == 400


def test_an_unknown_currency_is_refused(client, auth: dict[str, str]) -> None:
    """`Currency` is the seven spec §8.1 allows. `'usd'` is refused, not lower-cased.

    Case-insensitivity here would let `USD` and `usd` become two different values in a comparison that
    is supposed to be an equality.
    """
    assert _create(client, auth, currency="usd").status_code == 400
    assert _create(client, auth, currency="BTC").status_code == 400
    assert _create(client, auth, currency="JPY").status_code == 200


def test_the_merchant_url_becomes_iss_not_a_hardcoded_demo_shop(client, auth: dict[str, str]) -> None:
    """Spec §8.3's second required change: `iss` = our merchant URL.

    The reference helper hard-codes `https://tennis-warehouse.com`. With two merchants seeded, a
    hard-coded `iss` would make every price lock indistinguishable by issuer.
    """
    other = {
        "id": "mrc_babolat",
        "name": "Babolat",
        "website": "https://babolat.countersign.test",
    }
    body = _create(client, auth, merchant=other).json()

    assert decode_checkout_jwt_payload(body["checkout_jwt"])["iss"] == "https://babolat.countersign.test"
    assert decode_checkout_jwt_payload(body["checkout_jwt"])["merchant"]["id"] == "mrc_babolat"


def test_a_price_lock_signed_with_a_foreign_key_does_not_verify(client, auth: dict[str, str]) -> None:
    """A structurally valid JWT naming a key we do not hold is rejected."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from verifiable_intent.crypto.signing import public_key_to_jwk

    from vi_service.checkout_jwt import _jwt_encode

    stranger = ec.generate_private_key(ec.SECP256R1())
    forged = _jwt_encode(
        {"alg": "ES256", "typ": "JWT", "kid": public_key_to_jwk(stranger)["x"][:12]},
        {"iss": MERCHANT["website"], "sub": "cart_checkout", "iat": 1, "exp": 9_999_999_999, "cart": {}},
        stranger,
    )

    valid, reason = verify_checkout_signature(forged)
    assert valid is False
    assert "unknown merchant key id" in reason


def test_a_price_lock_with_a_swapped_header_algorithm_does_not_verify(client, auth: dict[str, str]) -> None:
    """`alg: none` and a non-ES256 `alg` are refused before any signature work.

    An algorithm-confusion downgrade is the classic JWT failure; the check is cheap and belongs at the
    boundary rather than being left to `es256_verify`.
    """

    from vi_service.checkout_jwt import _jwt_encode
    from vi_service.keys import get_keystore

    for alg, typ in (("none", "JWT"), ("ES384", "JWT"), ("ES256", "sd+jwt")):
        forged = _jwt_encode(
            {"alg": alg, "typ": typ, "kid": "merchant-key-1"},
            {"iss": MERCHANT["website"], "sub": "cart_checkout", "iat": 1, "exp": 9_999_999_999},
            get_keystore().signing_key("MERCHANT"),
        )
        valid, reason = verify_checkout_signature(forged)
        assert valid is False, alg
        assert "alg must be ES256" in reason or "typ must be" in reason


def test_the_diagnostic_route_reports_a_broken_price_lock_as_invalid(client, auth: dict[str, str]) -> None:
    """`GET /v1/checkout-jwt/verify` always answers `{valid, reason}` — a broken JWT is `valid: false`.

    The point of the endpoint is to be asked "is this thing good?". Answering 400 to that question
    would make it useless for its only purpose.
    """
    body = client.get("/v1/checkout-jwt/verify?checkout_jwt=not-a-jwt", headers=auth).json()

    assert body["valid"] is False
    assert body["reason"]
    assert body["checked_at"] > 0


def test_the_diagnostic_route_requires_auth(client) -> None:
    """It sits on the private surface so it cannot be used as a free oracle by the public."""
    assert client.get("/v1/checkout-jwt/verify?checkout_jwt=a.b.c").status_code == 401


def _walk(value: object, path: str = "$") -> Iterator[tuple[str, object]]:
    """Yield `(json_path, leaf)` for every scalar in a decoded payload."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, f"{path}[{index}]")
    else:
        yield path, value
