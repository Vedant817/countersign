"""AT-M3.1: a full autonomous chain round-trips through the HTTP surface → `chain_valid=True`.

The chain here is built by driving every real signing route in order — `/v1/l1/issue`,
`/v1/l2/prepare`, `/v1/l2/finalize`, `/v1/checkout-jwt`, `/v1/l3/create` — and then handed to
`/v1/verify`. Nothing is assembled by hand, so a green test says the *service* works, not that a
test helper can sign.
"""

from __future__ import annotations

import base64
import json

from conftest import AMOUNT_RANGE_MAX, MERCHANT, TOTAL_MINOR


def test_AT_M3_1_full_autonomous_chain_round_trip(client, auth: dict[str, str], full_chain) -> None:
    """AT-M3.1 — L1 → L2 → (checkout JWT → L3a + L3b) verifies, with constraints satisfied."""
    response = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth)

    assert response.status_code == 200
    body = response.json()

    assert body["chain_valid"] is True, body["errors"]
    assert body["errors"] == []
    assert body["constraints"]["satisfied"] is True
    assert body["constraints"]["violations"] == []
    assert body["verified_at"] > 0
    assert body["clock_skew_seconds"] == 300


def test_AT_M3_1_report_names_the_keys_the_chain_used(client, auth: dict[str, str], full_chain) -> None:
    """The response identifies the issuer, the device thumbprint and the agent kid.

    An evidence packet has to be able to say *which* keys signed it, so these three are part of the
    contract rather than a debugging extra.
    """
    body = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()

    assert body["keys"]["issuer_kid"] == "issuer-key-1"
    assert body["keys"]["agent_kid"] == full_chain.agent_kid
    assert body["keys"]["device_jkt"] == full_chain.device_jkt
    assert body["keys"]["merchant_kid"] == "merchant-key-1"


def test_AT_M3_1_every_mandate_pair_check_ran(client, auth: dict[str, str], full_chain) -> None:
    """`checks_performed` names the real checks, so a reviewer can see what was actually verified."""
    body = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()

    performed = body["checks_performed"]
    for expected in (
        "open_checkout_contains_line_items",
        "open_payment_contains_reference",
        "l2_reference_binding",
        "pair_0_identity_binding",
        "l3a_(payment)_structural_chain",
        "l3b_(checkout)_structural_chain",
        "l3_cross_reference",
        "l1_card_id_cross_check",
    ):
        assert expected in performed, f"{expected} did not run; performed={performed}"


def test_AT_M3_1_aud_and_nonce_are_checked_when_supplied(client, auth: dict[str, str], full_chain) -> None:
    """A matching `expected_aud` turns a skipped check into a performed one."""
    body = client.post(
        "/v1/verify",
        json=full_chain.verify_body(
            expected_aud="https://agent.countersign.test", expected_nonce="nonce-test-1"
        ),
        headers=auth,
    ).json()

    assert body["chain_valid"] is True
    assert "l2_aud" in body["checks_performed"]
    assert "l2_nonce" in body["checks_performed"]
    assert not [s for s in body["checks_skipped"] if s.startswith("l2_aud")]


def test_AT_M3_1_wrong_expected_aud_invalidates_the_chain(client, auth: dict[str, str], full_chain) -> None:
    """An `expected_aud` that does not match is a chain error, still with HTTP 200."""
    response = client.post(
        "/v1/verify", json=full_chain.verify_body(expected_aud="https://evil.example"), headers=auth
    )

    assert response.status_code == 200
    body = response.json()
    assert body["chain_valid"] is False
    assert any("aud mismatch" in e for e in body["errors"])


def test_AT_M3_1_amount_and_payee_in_the_response_match_what_was_signed(
    client, auth: dict[str, str], full_chain
) -> None:
    """`disclosed` carries the resolved L3a claims, amount as an integer in minor units."""
    body = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()

    payment = next(
        d
        for d in body["disclosed"]["l3a"]["delegate_payload"]
        if isinstance(d, dict) and d.get("vct") == "mandate.payment.1"
    )
    assert payment["payment_amount"] == {"currency": "USD", "amount": TOTAL_MINOR}
    assert isinstance(payment["payment_amount"]["amount"], int)
    assert payment["payee"]["id"] == MERCHANT["id"]
    assert payment["transaction_id"] == full_chain.checkout_hash


def test_AT_M3_1_verifying_the_same_chain_twice_is_stable(client, auth: dict[str, str], full_chain) -> None:
    """Verification is deterministic — a dispute re-verified a month later gets the same verdict."""
    first = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()
    second = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()

    assert first["chain_valid"] == second["chain_valid"] is True
    assert first["constraints"] == second["constraints"]


def test_AT_M3_1_amount_range_max_is_enforced_at_the_stated_bound(
    client, auth: dict[str, str], full_chain
) -> None:
    """The round-trip fixture sits under `amount_range.max`, so the happy path is a real check."""
    assert TOTAL_MINOR < AMOUNT_RANGE_MAX
    body = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()
    assert "mandate.payment.amount_range" in body["constraints"]["checked"]


# ====================================================================================================
# AT-M3.2 — two-phase signing with an external key (spec D3, §11 check C3(a), [B2])
#
# This is the load-bearing test of the whole service. The browser holds a non-extractable key the
# service never sees, so `/v1/l2/prepare` builds the body and `/v1/l2/finalize` must check the
# browser's signature against the L1's device key before it will hand back a token.
#
# A wrong key must produce VI_SIGNATURE_MISMATCH and no token. If that ever regressed to "return the
# body anyway", anyone could attach any signature to any mandate — the L2 *is* the consent, so the
# product's core claim would be false while every other test still passed.
# ====================================================================================================


def test_AT_M3_2_prepare_returns_header_dot_payload_and_no_signature(
    client, auth, builder, device_key, agent_key
) -> None:
    """`signing_input` is the two JWS segments and nothing else — no signature, no disclosures.

    The disclosures are appended by `finalize`'s caller-side presentation logic; a `signing_input`
    carrying them would commit the browser to disclosures the user has not been shown yet.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    segments = prepared["signing_input"].split(".")
    assert len(segments) == 2
    assert "~" not in prepared["signing_input"]

    header = json.loads(base64.urlsafe_b64decode(segments[0] + "=" * (-len(segments[0]) % 4)))
    assert header["alg"] == "ES256"
    assert header["typ"] == "kb-sd-jwt+kb"
    assert header["kid"] == device_key.kid


def test_AT_M3_2_prepare_returns_the_payload_the_ui_must_render(
    client, auth, builder, agent_key, device_key
) -> None:
    """Spec §8.5: the browser renders *this* payload, not its own copy of the constraints.

    So the decoded payload has to be complete and self-describing — the read-back is the whole
    informed-consent mechanism.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    payload = prepared["payload"]

    assert payload["aud"] == "https://agent.countersign.test"
    assert payload["nonce"] == "nonce-test-1"
    assert payload["_sd_alg"] == "sha-256"
    # Exactly the claims the library serialises, so an unexpected extra claim is caught here rather
    # than by a reviewer wondering what the browser was asked to sign.
    assert set(payload) == {"nonce", "aud", "iat", "sd_hash", "delegate_payload", "_sd_alg", "_sd", "exp"}
    assert len(payload["delegate_payload"]) == 2  # open checkout + open payment mandate
    assert all(set(entry) == {"..."} for entry in payload["delegate_payload"])


def test_AT_M3_2_prompt_summary_is_not_covered_by_the_signature(
    client, auth, builder, agent_key, device_key
) -> None:
    """The pinned library **drops** `prompt_summary`, so it is not part of what the user signs.

    `UserMandate` has the field and `create_layer2_autonomous` never reads it, so it never reaches
    the payload or the disclosures. We still accept it (spec §8.3's `l2/prepare` request names it),
    but the UI must not present it as signed content. Asserted here so the day the library starts
    serialising it, this test says so.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    assert "prompt_summary" not in prepared["payload"]
    assert "prompt_summary" not in json.dumps(prepared["payload"])


def test_AT_M3_2_external_key_signs_and_the_chain_verifies(
    client, auth, builder, device_key, agent_key
) -> None:
    """AT-M3.2 — sign with a separate `cryptography` key (DER → r‖s), finalize, verify → valid."""
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    signature = device_key.sign(prepared["signing_input"])

    finalized = builder.finalize_l2(prepared["prepare_id"], signature)
    assert finalized.status_code == 200, finalized.text
    l2_serialized = finalized.json()["l2"]

    # The JWS is exactly what the browser signed; the disclosures follow it, SD-JWT framing and all.
    jws, _, disclosures = l2_serialized.partition("~")
    assert jws == f"{prepared['signing_input']}.{signature}"
    assert disclosures.endswith("~")
    assert len(disclosures.split("~")) - 1 == 4  # merchant, item, open checkout, open payment

    checkout = builder.checkout_jwt()
    l3 = builder.create_l3(l2_serialized, checkout, agent_key)
    assert l3.status_code == 200, l3.text

    verified = client.post(
        "/v1/verify",
        json={
            "l1": l1["l1"],
            "l2": l2_serialized,
            "l3a": l3.json()["l3a"],
            "l3b": l3.json()["l3b"],
            "checkout_jwt": checkout["checkout_jwt"],
        },
        headers=auth,
    )
    assert verified.status_code == 200
    body = verified.json()
    assert body["chain_valid"] is True, body["errors"]


def test_AT_M3_2_wrong_key_is_rejected_with_no_token(
    client, auth, builder, wrong_key, agent_key, device_key
) -> None:
    """AT-M3.2 — the wrong key yields `VI_SIGNATURE_MISMATCH` and **no** L2.

    The failing assertion that matters: the response has no `l2` field at all. A 400 with a body that
    leaked the L2 would defeat the entire check.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    response = builder.finalize_l2(prepared["prepare_id"], wrong_key.sign(prepared["signing_input"]))

    assert response.status_code == 400, response.text
    assert "l2" not in response.json(), "a rejected signature must not return any part of the L2"
    assert prepared["signing_input"] not in response.text

    error = response.json()["error"]
    assert error["code"] == "VI_SIGNATURE_MISMATCH"
    assert error["retryable"] is False
    assert error["userMessage"] == "The signature did not match the key in the mandate, so we stopped."
    # The `device_jkt` reported must be the *enrolled* key's, so an operator can see which key was
    # expected — and it must not be the impostor's.
    assert error["details"]["device_jkt"] == device_key.jkt
    assert error["details"]["device_jkt"] != wrong_key.jkt


def test_AT_M3_2_a_signature_over_different_bytes_is_rejected(
    client, auth, builder, device_key, agent_key
) -> None:
    """A correct key signing the wrong message must fail too.

    Otherwise the check would be "does any valid device signature exist", not "did the user sign
    *this* mandate" — which is the property consent actually needs.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    tampered = prepared["signing_input"][:-4] + (
        "AAAA" if prepared["signing_input"][-4:] != "AAAA" else "BBBB"
    )
    response = builder.finalize_l2(prepared["prepare_id"], device_key.sign(tampered))

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VI_SIGNATURE_MISMATCH"


def test_AT_M3_2_signature_must_be_64_raw_bytes_not_der(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """A DER signature is the wrong encoding, so it is `CS_VALIDATION`, not a mismatch.

    `es256_verify` returns `False` for any length ≠ 64 rather than raising, so without an explicit
    length gate a DER signature would be reported as a *key* problem and send the caller hunting
    for the wrong bug. Spec §8.5 [B4] pins the browser to P1363; the gate says so.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    der_signature = device_key.sign_der(prepared["signing_input"])

    response = builder.finalize_l2(prepared["prepare_id"], der_signature)
    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["code"] == "CS_VALIDATION"
    assert error["details"]["expected_bytes"] == 64
    assert error["details"]["signature_bytes"] > 64
    assert "P1363" in error["message"] or "raw" in error["message"]


def test_AT_M3_2_truncated_and_padded_signatures_are_rejected(
    client, auth, builder, device_key, agent_key
) -> None:
    """63 bytes and 65 bytes are both `CS_VALIDATION`, never a token."""

    from vi_service.keys import b64u_decode, b64u_encode

    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    good = b64u_decode(device_key.sign(prepared["signing_input"]))

    for mutated in (good[:63], good + b"\x00"):
        response = builder.finalize_l2(prepared["prepare_id"], b64u_encode(mutated))
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == "CS_VALIDATION"
    assert b64u_encode(b"\x00" * 64) is not None  # base64url round-trips a 64-byte zero signature


def test_AT_M3_2_prepare_is_repeatable(client, auth: dict[str, str], builder, device_key, agent_key) -> None:
    """Spec §8.4: `l2/prepare` is safe to repeat. Two prepares, two independent finalize IDs.

    Not byte-identical — the library salts every disclosure with 16 random bytes — but both
    finalize to a token that verifies. That is the property that lets the UI retry after a blip.
    """
    l1 = builder.issue_l1()
    first = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    second = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    assert first["prepare_id"] != second["prepare_id"]
    assert first["signing_input"] != second["signing_input"]

    for prepared in (first, second):
        finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
        assert finalized.status_code == 200, finalized.text


def test_AT_M3_2_a_prepared_l2_cannot_be_finalized_against_another_mandate(
    client, auth, builder, device_key, agent_key
) -> None:
    """Signing input A with the key enrolled for L1-A cannot finalize prepare-B.

    The store is keyed by `prepare_id` and pins the device key from the L1 that was used to build
    it, so there is no way to point one prepare's signature at another's L1.
    """
    l1_a = builder.issue_l1()
    prepared_a = builder.prepare_l2(l1_a["l1"], agent_key, instrument_id=l1_a["card_id"])

    other_key_response = client.post(
        "/v1/l1/issue",
        json={
            "user_id": "usr_other",
            "wallet": {
                "payer_id": "PAYER999",
                "payer_email": "other@countersign.test",
                "payment_token_id": "vault-token-xyz789",
            },
            "device_public_jwk": device_key.public_jwk,
            "device_kid": device_key.kid,
        },
        headers=auth,
    )
    l1_b = other_key_response.json()

    prepared_b = builder.prepare_l2(l1_b["l1"], agent_key, instrument_id=l1_b["card_id"])

    # Same device key, different mandate bytes: signing A does not complete B.
    response = builder.finalize_l2(prepared_b["prepare_id"], device_key.sign(prepared_a["signing_input"]))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VI_SIGNATURE_MISMATCH"

    # And signing B completes B.
    assert (
        builder.finalize_l2(
            prepared_b["prepare_id"], device_key.sign(prepared_b["signing_input"])
        ).status_code
        == 200
    )


def test_AT_M3_2_prepare_store_holds_only_the_bounded_window(
    client, auth, builder, device_key, agent_key
) -> None:
    """The in-memory store holds one record per prepare and no more (spec §8.3)."""
    from vi_service.l2 import get_prepare_store

    l1 = builder.issue_l1()
    store = get_prepare_store()
    assert len(store) == 0

    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    assert len(store) == 1
    assert store.get(prepared["prepare_id"]) is not None
    assert prepared["expires_at"] == prepared["payload"]["iat"] + 300


def test_AT_M3_2_prepare_refuses_a_constraint_with_an_unknown_merchant(
    client, auth, builder, agent_key, device_key
) -> None:
    """A constraint naming a merchant that is not in `merchants` is `VI_CONSTRAINT_VIOLATION`.

    The library raises here (`_match_merchant_refs`), which is a "bad constraint shape" and belongs
    to the caller to fix — spec §8.3 names exactly that code for `l2/prepare`.
    """
    l1 = builder.issue_l1()
    response = client.post(
        "/v1/l2/prepare",
        json={
            "l1": l1["l1"],
            "device_kid": device_key.kid,
            "agent_public_jwk": agent_key.public_jwk,
            "agent_kid": agent_key.kid,
            "checkout_constraints": [
                {
                    "type": "mandate.checkout.allowed_merchants",
                    "allowed": [
                        {"id": "mrc_never_listed", "name": "Ghost Shop", "website": "https://ghost.test"}
                    ],
                },
                {
                    "type": "mandate.checkout.line_items",
                    "items": [
                        {
                            "id": "li",
                            "acceptable_items": [{"id": "SKU-TRAIL-42", "title": "Trail Runner"}],
                            "quantity": 1,
                        }
                    ],
                },
            ],
            "payment_constraints": [],
            "merchants": [
                {
                    "id": "mrc_northwind",
                    "name": "Northwind Outfitters",
                    "website": "https://northwind.countersign.test",
                }
            ],
            "acceptable_items": [{"id": "SKU-TRAIL-42", "title": "Trail Runner"}],
            "payment_instrument": {"type": "paypal_vault", "id": l1["card_id"], "description": "PayPal"},
            "nonce": "n",
            "aud": "https://agent.countersign.test",
        },
        headers=auth,
    )
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "VI_CONSTRAINT_VIOLATION"
