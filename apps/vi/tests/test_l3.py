"""AT-M3.8 and the L3 signing path: the pre-check is what makes this route safe.

The agent is the untrusted party in this system (spec §3.1: the agent chat is an untrusted input
surface; the LLM's output is never authority). `POST /v1/l3/create` is the last point before a
purchasing authority exists, so it evaluates the L2's own constraints before it signs anything.
"""

from __future__ import annotations

import base64

import pytest
from conftest import CURRENCY, ITEM, MERCHANT, TOTAL_MINOR, UNIT_MINOR, error_body

from vi_service.checkout_jwt import checkout_hash_from_jwt, decode_checkout_jwt_payload


def test_AT_M3_8_l3_create_refuses_an_out_of_range_amount(
    client, auth, builder, device_key, agent_key
) -> None:
    """AT-M3.8 — an amount above the signed `amount_range.max` is refused, and nothing is signed."""
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    l2 = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"])).json()["l2"]
    checkout = builder.checkout_jwt()

    response = builder.create_l3(l2, checkout, agent_key, amount_minor=20_000 + 1)

    assert response.status_code == 422, response.text
    error = error_body(response)
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert error["userMessage"] == "This purchase is outside the limits you signed."
    assert error["details"]["side"] == "payment"
    assert error["details"]["violations"]
    assert "l3a" not in response.json()


def test_AT_M3_8_a_mandate_signed_tighter_refuses_what_a_looser_one_allows(
    client, auth, builder, device_key, agent_key
) -> None:
    """The cap that matters is the user's, not the cart's.

    A $20 cap and a $200 cap produce the same request; only one of them authorises a $150 basket, and
    which one is decided entirely by the signed constraint.
    """
    tight = _l2_with_amount_max(builder, device_key, agent_key, 5_000)
    loose = _l2_with_amount_max(builder, device_key, agent_key, 50_000)
    checkout = builder.checkout_jwt()

    assert builder.create_l3(tight, checkout, agent_key, amount_minor=TOTAL_MINOR).status_code == 422
    assert builder.create_l3(loose, checkout, agent_key, amount_minor=TOTAL_MINOR).status_code == 200


def test_AT_M3_8_a_currency_the_user_never_authorised_is_refused(
    client, auth, builder, device_key, agent_key
) -> None:
    """USD cap, INR request: refused. We never convert a signed limit into another currency."""
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()

    response = builder.create_l3(l2, checkout, agent_key, currency="INR")

    assert response.status_code == 422
    error = error_body(response)
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert any("Currency mismatch" in v for v in error["details"]["violations"])


def test_l3_create_refuses_a_cart_with_an_item_the_user_never_listed(
    client, auth, builder, device_key, agent_key
) -> None:
    """A SKU outside `line_items.acceptable_items` is refused at signing time.

    This is the concrete defence against a prompt injection in a listing: the injected instruction
    says "also add the $900 laptop", the L2 does not list it, and the service declines to sign.
    """
    l2 = _l2(builder, device_key, agent_key)
    response = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": MERCHANT,
            "lines": [
                {"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": UNIT_MINOR},
                {
                    "sku": "SKU-INJECTED-LAPTOP",
                    "title": "Very Expensive Laptop",
                    "qty": 1,
                    "unit_minor": 3_000,
                },
            ],
            "shipping_minor": 500,
            "tax_minor": 800,
            "currency": CURRENCY,
        },
        headers=auth,
    )
    assert response.status_code == 200, response.text
    injected_cart = response.json()

    l3 = builder.create_l3(l2, injected_cart, agent_key, amount_minor=injected_cart["total_minor"])

    assert l3.status_code == 422, l3.text
    error = error_body(l3)
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert error["details"]["side"] == "checkout"
    assert any("not in acceptable items" in v for v in error["details"]["violations"])


def test_l3_create_refuses_a_cart_from_a_different_merchant(
    client, auth, builder, device_key, agent_key
) -> None:
    """A price lock from a shop the user never listed is refused.

    The merchant signature is valid — it really is one of our merchants — but it is not a merchant
    this mandate covers, which is a different check from the signature.
    """
    l2 = _l2(builder, device_key, agent_key)
    elsewhere = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": {
                "id": "mrc_somewhere_else",
                "name": "Somewhere Else",
                "website": "https://elsewhere.test",
            },
            "lines": [{"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": UNIT_MINOR}],
            "currency": CURRENCY,
        },
        headers=auth,
    ).json()

    response = builder.create_l3(l2, elsewhere, agent_key, amount_minor=UNIT_MINOR)

    assert response.status_code == 422
    error = error_body(response)
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert any("not in allowed list" in v for v in error["details"]["violations"])


def test_l3_create_refuses_an_expired_price_lock(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """EC-PRICE-2: a stale price lock must be re-quoted, not honoured at yesterday's price.

    Signed with a `ttl_seconds` in the past, so the refusal is about the lock's own window rather
    than about any constraint.
    """
    l2 = _l2(builder, device_key, agent_key)
    expired = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": MERCHANT,
            "lines": [{"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": UNIT_MINOR}],
            "currency": CURRENCY,
            "ttl_seconds": 30,
        },
        headers=auth,
    ).json()

    import time

    # Age the price lock without sleeping: rewrite its `exp` and re-sign with the real merchant key.
    from vi_service.checkout_jwt import _jwt_encode
    from vi_service.keys import get_keystore

    payload = decode_checkout_jwt_payload(expired["checkout_jwt"])
    payload["exp"] = int(time.time()) - 1
    aged = _jwt_encode(
        {"alg": "ES256", "typ": "JWT", "kid": expired["kid"]}, payload, get_keystore().signing_key("MERCHANT")
    )
    assert aged != expired["checkout_jwt"]

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": agent_key.kid,
            "enc_private_key_b64": agent_key.enc_private_key_b64,
            "l2": l2,
            "checkout_jwt": aged,
            "payment": {"amount_minor": UNIT_MINOR, "currency": CURRENCY, "payee_id": MERCHANT["id"]},
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )

    assert response.status_code == 422, response.text
    error = error_body(response)
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert "re-quote" in error["message"]


def test_l3_create_refuses_a_checkout_jwt_it_did_not_sign(
    client, auth, builder, device_key, agent_key
) -> None:
    """A price lock signed by a key we do not hold is refused before any constraint is considered."""
    l2 = _l2(builder, device_key, agent_key)

    forged = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": MERCHANT,
            "lines": [{"sku": ITEM["id"], "title": ITEM["title"], "qty": 1, "unit_minor": 1}],
            "currency": CURRENCY,
        },
        headers=auth,
    ).json()
    parts = forged["checkout_jwt"].split(".")
    parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": agent_key.kid,
            "enc_private_key_b64": agent_key.enc_private_key_b64,
            "l2": l2,
            "checkout_jwt": ".".join(parts),
            "payment": {"amount_minor": 1, "currency": CURRENCY, "payee_id": MERCHANT["id"]},
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )

    assert response.status_code == 422, response.text
    error = error_body(response)
    assert error["code"] == "VI_CHAIN_INVALID"
    assert "merchant key" in error["message"]


def test_l3_returns_both_split_credentials_and_a_content_bound_jti(
    client, auth: dict[str, str], full_chain
) -> None:
    """`jti` is a pure function of the signed L3a bytes, so a replayed token reuses its id.

    `checkout_attempts.l3_jti` is unique and is what makes `GATE_REPLAY` possible. Two different
    authorisations cannot collide on it, and the same one cannot escape it by being re-sent.
    """
    import hashlib

    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(full_chain.l3a.split("~")[0].encode("ascii")).digest())
        .rstrip(b"=")
        .decode()
    )
    assert full_chain.jti == expected
    assert len(full_chain.jti) == 43  # base64url of 32 bytes


def test_EC_IDEM_1_jti_identifies_the_signed_token_not_the_request(
    client, auth: dict[str, str], builder, device_key, agent_key, full_chain
) -> None:
    """EC-IDEM-1 — the two semantics asserted separately, because they pull opposite ways.

    QA2-VI-2 falsified half of D-011: `jti` was documented as "deterministic, so a retried request
    yields the same jti". It is not, and it must not be. `create_disclosure` mints a fresh
    `os.urandom(16)` salt per disclosure, so even **inside the same second** two `l3/create` calls
    produce different bytes and therefore different ids. A retried request is a new authorisation,
    and reusing its id would make the UNIQUE index refuse a legitimate retry.

    So the assertions are:
      1. same signed L3a bytes  -> same `jti`  (the replay defence fires — Gate check 7)
      2. two `l3/create` calls -> different `jti`  (a retry is not blocked as a replay)
    """
    # A second, independent call on the same L2 and the same price lock. `builder.create_l3` takes
    # the checkout *response body*, not the JWT string.
    second = builder.create_l3(
        full_chain.l2, {"checkout_jwt": full_chain.checkout_jwt}, agent_key, amount_minor=TOTAL_MINOR
    )
    assert second.status_code == 200, second.text
    body = second.json()

    assert body["jti"] != full_chain.jti, "a fresh authorisation must not reuse a replay id"
    assert body["l3a"] != full_chain.l3a, "the disclosure salts differ, so the tokens differ"

    # (1) The replay defence. `jti` is derived from the L3a issuer JWT, so re-deriving it from the
    # bytes a captured token carries reproduces the id exactly. That is the property check 7 relies
    # on: the same signed token, submitted twice, hits the UNIQUE index and becomes GATE_REPLAY.
    assert _jti_of(full_chain.l3a) == full_chain.jti
    assert len(full_chain.jti) == 43

    # And it is *only* a function of the signed bytes. Mutating one character of the JWS yields a
    # different id, so the defence cannot be sidestepped by submitting a mutated authorisation under
    # the old one.
    head, _, tail = full_chain.l3a.partition("~")
    flipped = head[:-1] + ("A" if head[-1] != "A" else "B") + f"~{tail}"
    assert flipped.split("~")[0] != head
    assert _jti_of(flipped) != full_chain.jti

    # Stated precisely, because it is a real and slightly surprising boundary: the id covers the
    # **issuer JWT** only, not the disclosure section. Two presentations of one signed token share an
    # id. That is correct — the disclosures are unsigned (see the QA2-VI-1 gate), so they cannot be
    # part of a replay identity, and the chain verifier is what establishes completeness.
    assert _jti_of(f"{head}~") == full_chain.jti


def test_l3a_and_l3b_are_addressed_to_different_audiences(client, auth: dict[str, str], full_chain) -> None:
    """L3a goes to the payment network; L3b goes to the merchant that will ship.

    Both carry the same `nonce`, which is what lets the Gate correlate one purchase's two halves.
    """
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt

    l3a = decode_sd_jwt(full_chain.l3a).payload
    l3b = decode_sd_jwt(full_chain.l3b).payload

    assert l3a["aud"] == "https://network.countersign.test"
    assert l3b["aud"] == MERCHANT["website"]
    assert l3a["nonce"] == l3b["nonce"]
    assert "cnf" not in l3a, "an L3 is terminal: it must not delegate any further"
    assert "cnf" not in l3b


def test_l3_returns_the_two_selective_presentation_strings(
    client, auth, builder, device_key, agent_key
) -> None:
    """`l3/create` hands back the L2 slices, so `verify` and the Gate recompute the same sd_hashes.

    The split is the point: the merchant must not see the payment mandate, and the network must not
    see the cart. If the presentation strings were not published, a caller would have to guess them.
    """
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()
    body = builder.create_l3(l2, checkout, agent_key).json()

    # SD-JWT framing: `base~d1~d2~`, so the trailing split element is the empty string.
    payment_segments = _segments(body["payment_presentation"])
    checkout_segments = _segments(body["checkout_presentation"])

    assert len(payment_segments) == 3  # base + payment mandate + merchant
    assert len(checkout_segments) == 3  # base + checkout mandate + item
    assert body["payment_presentation"].endswith("~")
    assert checkout_segments[0] == payment_segments[0] == _segments(l2)[0]
    assert set(payment_segments) & set(checkout_segments) == {payment_segments[0]}
    assert payment_segments[1] != checkout_segments[1]


def test_l3_network_slice_contains_neither_the_cart_nor_the_checkout_mandate(
    client, auth, builder, device_key, agent_key
) -> None:
    """The network's slice of the L2 carries no checkout data, and the merchant's carries no payment.

    `examples/helpers.py::build_role_presentations` refuses to fall back to the full L2 for exactly
    this reason. Here the fallback is structurally impossible: each presentation is built from a
    fixed pair of disclosures, so there is no code path that could hand a merchant the payment
    mandate.
    """
    from verifiable_intent.crypto.disclosure import decode_disclosure
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures

    l2 = _l2(builder, device_key, agent_key)
    body = builder.create_l3(l2, builder.checkout_jwt(), agent_key).json()

    network_view = resolve_disclosures(decode_sd_jwt(body["payment_presentation"]))
    merchant_view = resolve_disclosures(decode_sd_jwt(body["checkout_presentation"]))

    network_vcts = {
        d.get("vct") for d in network_view["delegate_payload"] if isinstance(d, dict) and d.get("vct")
    }
    merchant_vcts = {
        d.get("vct") for d in merchant_view["delegate_payload"] if isinstance(d, dict) and d.get("vct")
    }

    assert network_vcts == {"mandate.payment.open.1"}
    assert merchant_vcts == {"mandate.checkout.open.1"}

    # And the raw disclosures themselves hold no amount or cart.
    network_text = " ".join(body["payment_presentation"].split("~"))
    assert "payment_amount" not in network_text
    assert "acceptable_items" not in network_text
    assert decode_disclosure(body["payment_presentation"].split("~")[1]) is not None


def test_l3_exp_never_exceeds_one_hour_from_iat(client, auth: dict[str, str], full_chain) -> None:
    """The library enforces `exp - iat <= 3600`; we default to 300 s and cap at 3600.

    A longer-lived L3 would let a captured authorisation be replayed much later, which is the
    `l3_jti` uniqueness and the Gate's replay window both assume it is not.
    """
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt

    for serialized in (full_chain.l3a, full_chain.l3b):
        claims = decode_sd_jwt(serialized).payload
        assert claims["exp"] - claims["iat"] == 300
        assert claims["exp"] - claims["iat"] <= 3600


def test_l3_ttl_seconds_above_the_library_ceiling_is_refused(
    client, auth, builder, device_key, agent_key
) -> None:
    """Asking for an L3 that lives longer than the library permits is a validation error.

    Better a clear 400 at the edge than a library error from deep inside signing.
    """
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": agent_key.kid,
            "enc_private_key_b64": agent_key.enc_private_key_b64,
            "l2": l2,
            "checkout_jwt": checkout["checkout_jwt"],
            "payment": {"amount_minor": TOTAL_MINOR, "currency": CURRENCY, "payee_id": MERCHANT["id"]},
            "aud": "https://network.countersign.test",
            "nonce": "n",
            "ttl_seconds": 7200,
        },
        headers=auth,
    )
    assert response.status_code == 400, response.text
    assert error_body(response)["details"]["fields"][0]["loc"][-1] == "ttl_seconds"


def test_l3_instrument_comes_from_the_l2_not_the_request(client, auth: dict[str, str], full_chain) -> None:
    """The L3a's `payment_instrument` is the L2's, which is why the two agree by construction.

    `verify_chain` cross-checks them and fails closed on a mismatch. If the request could set it, a
    caller would be able to swap the instrument between the consent and the authorisation — which is
    exactly the sort of gap spec §8.0 rule 3 is about.
    """
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures

    l3a = resolve_disclosures(decode_sd_jwt(full_chain.l3a))
    payment = next(d for d in l3a["delegate_payload"] if d.get("vct") == "mandate.payment.1")
    assert payment["payment_instrument"]["id"] == full_chain.card_id
    assert payment["payment_instrument"]["type"] == "paypal_vault"


def test_l3_checkout_hash_agrees_with_the_library_byte_for_byte(
    client, auth: dict[str, str], full_chain
) -> None:
    """The hash we publish is the hash the library recomputes.

    `integrity.verify_checkout_hash_binding` and `issuance/user.py` both compute
    `base64url(sha256(jwt.encode("ascii")))`. If ours differed by even a byte the chain would fail
    with a mismatch that reads like tampering.
    """
    assert checkout_hash_from_jwt(full_chain.checkout_jwt) == full_chain.checkout_hash

    import hashlib

    from verifiable_intent.crypto.disclosure import _b64url_encode

    assert full_chain.checkout_hash == _b64url_encode(
        hashlib.sha256(full_chain.checkout_jwt.encode("ascii")).digest()
    )


def test_l3_create_refuses_a_non_integer_amount(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """Money is integer minor units. A float or a formatted string is refused at the edge.

    Spec §0 and §8.0 rule 9. `130.0` in JSON would become `130` minor units — a hundredfold error —
    if anything coerced it, so nothing here does.
    """
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()

    for bad in (13_000.0, "13000", True, 13_000.5):
        response = client.post(
            "/v1/l3/create",
            json={
                "agent_kid": agent_key.kid,
                "enc_private_key_b64": agent_key.enc_private_key_b64,
                "l2": l2,
                "checkout_jwt": checkout["checkout_jwt"],
                "payment": {"amount_minor": bad, "currency": CURRENCY, "payee_id": MERCHANT["id"]},
                "aud": "https://network.countersign.test",
                "nonce": "n",
            },
            headers=auth,
        )
        assert response.status_code == 400, f"{bad!r} -> {response.status_code} {response.text}"
        assert error_body(response)["code"] == "CS_VALIDATION"


@pytest.mark.parametrize("field", ["amount_minor", "currency", "payee_id"])
def test_l3_payment_requires_all_three_fields(
    client, auth: dict[str, str], builder, device_key, agent_key, field
) -> None:
    """`payment` is closed: a missing field is an error, not a default."""
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()
    payment = {"amount_minor": TOTAL_MINOR, "currency": CURRENCY, "payee_id": MERCHANT["id"]}
    payment.pop(field)

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": agent_key.kid,
            "enc_private_key_b64": agent_key.enc_private_key_b64,
            "l2": l2,
            "checkout_jwt": checkout["checkout_jwt"],
            "payment": payment,
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )
    assert response.status_code == 400
    assert error_body(response)["details"]["fields"][0]["loc"] == ["body", "payment", field]


# --- helpers -----------------------------------------------------------------------------------------


def _jti_of(l3a: str) -> str:
    """The `jti` `l3/create` would report for these L3a bytes.

    The same derivation `create_l3` performs, so a test can ask "does this token carry this replay
    id?" without minting a new token — which is the whole point, because minting one produces
    different bytes.
    """
    import hashlib

    return (
        base64.urlsafe_b64encode(hashlib.sha256(l3a.split("~")[0].encode("ascii")).digest())
        .rstrip(b"=")
        .decode()
    )


def _segments(presentation: str) -> list[str]:
    """The non-empty `~`-separated segments of an SD-JWT presentation."""
    return [segment for segment in presentation.split("~") if segment]


def _l2(builder, device_key, agent_key, max_minor: int = 20_000) -> str:
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(
        l1["l1"], agent_key, instrument_id=l1["card_id"], payment=_payment_constraints(max_minor)
    )
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    assert finalized.status_code == 200, finalized.text
    return finalized.json()["l2"]


def _l2_with_amount_max(builder, device_key, agent_key, max_minor: int) -> str:
    return _l2(builder, device_key, agent_key, max_minor)


def _payment_constraints(max_minor: int) -> list[dict]:
    from conftest import allowed_payees_constraint, budget_constraint, recurrence_constraint

    return [
        {"type": "mandate.payment.amount_range", "currency": CURRENCY, "min": 0, "max": max_minor},
        allowed_payees_constraint(MERCHANT["id"]),
        budget_constraint(max_minor),
        recurrence_constraint(),
    ]
