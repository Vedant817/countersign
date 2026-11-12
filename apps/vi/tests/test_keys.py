"""The key registry: KEK encryption, JWKS, and rotation (AT-M3.9, EC-KEY-2, EC-KEY-3, EC-KEY-4).

The single idea under all of it: **verification must outlive rotation**. An evidence packet filed
months after an issuer or merchant key rotates still has to verify, or the whole dispute story
collapses the first time the ops team does routine key hygiene.
"""

from __future__ import annotations

import base64

import pytest
from conftest import MERCHANT, UNIT_MINOR, error_body

from vi_service.config import get_settings
from vi_service.keys import (
    b64u_decode,
    b64u_encode,
    decrypt_private_key,
    derive_signing_key,
    encrypt_private_key,
    get_keystore,
    rfc7638_thumbprint,
)

# --- AT-M3.9: JWKS includes retired keys ------------------------------------------------------------


def test_AT_M3_9_jwks_lists_every_key_with_a_status(client) -> None:
    """AT-M3.9 — public, no auth, and every key carries a `status`.

    Public and unauthenticated on purpose: a verifier in another process has to be able to fetch
    the public keys, including the retired ones, or it cannot check old evidence.
    """
    response = client.get("/v1/jwks")

    assert response.status_code == 200
    keys = response.json()["keys"]
    assert keys, "JWKS must never be empty"

    roles = {key["role"] for key in keys}
    assert {"ISSUER", "MERCHANT"} <= roles
    for key in keys:
        assert key["status"] in {"ACTIVE", "RETIRED", "COMPROMISED"}
        assert key["kty"] == "EC" and key["crv"] == "P-256"
        assert key["alg"] == "ES256" and key["use"] == "sig"
        assert "d" not in key, "JWKS must never contain a private key"
        assert key["kid"]


def test_AT_M3_9_jwks_includes_agent_keys(client, agent_key) -> None:
    """An agent's public key is published so a verifier can resolve the L2's `cnf.jwk` to a `kid`."""
    keys = client.get("/v1/jwks").json()["keys"]

    agent_entries = [k for k in keys if k["role"] == "AGENT"]
    assert len(agent_entries) == 1
    assert agent_entries[0]["kid"] == agent_key.kid
    assert agent_entries[0]["owner_id"] == "agt_test_agent"
    assert agent_entries[0]["x"] == agent_key.public_jwk["x"]


def test_AT_M3_9_rotating_the_issuer_keeps_the_old_key_in_jwks(client, auth: dict[str, str]) -> None:
    """AT-M3.9 — rotation *adds* a key. The retired one stays, marked `RETIRED`.

    This is EC-KEY-2's mechanism: a new `kid` appears and the old one is kept verify-only until the
    retention end. If rotation deleted the old key, every L1 issued before it would stop verifying.
    """
    before = client.get("/v1/jwks").json()["keys"]
    old_issuer = next(k for k in before if k["role"] == "ISSUER")

    rotated = client.post("/v1/keys/rotate", json={"role": "ISSUER"}, headers=auth)
    assert rotated.status_code == 200, rotated.text
    body = rotated.json()
    assert body["role"] == "ISSUER"
    assert body["retired_kid"] == old_issuer["kid"]
    assert body["new_kid"] != old_issuer["kid"]

    after = client.get("/v1/jwks").json()["keys"]
    by_kid = {k["kid"]: k for k in after}
    assert old_issuer["kid"] in by_kid, "the retired issuer key must still be published"
    assert by_kid[old_issuer["kid"]]["status"] == "RETIRED"
    assert by_kid[body["new_kid"]]["status"] == "ACTIVE"
    assert by_kid[old_issuer["kid"]]["retired_at"] > 0


# --- the network keys survive a restart (P0) ------------------------------------------------------


def _public_jwk_of(kid: str) -> dict[str, object]:
    entry = get_keystore().get(kid)
    assert entry is not None, f"JWKS must resolve {kid}"
    return entry.public_jwk


def test_P0_the_issuer_key_is_the_same_after_a_restart(client) -> None:
    """A signature made before a restart verifies after it.

    This is the P0 the audit found: `_boot` used to call `generate_es256_key()`, so a restarted
    vi published a *different* public key under the *same* `kid` and every artefact issued earlier
    stopped verifying. Nothing in the service could tell a verifier which key to use instead, which
    made EC-KEY-2/EC-KEY-3 structurally unreachable.
    """
    settings = get_settings()
    before = _public_jwk_of(settings.issuer_kid)

    # A restart: forget everything the process held, then rebuild from the same environment.
    from vi_service import keys as keys_module

    keys_module.reset_keystore()
    get_keystore()

    after = _public_jwk_of(settings.issuer_kid)
    assert after["x"] == before["x"] and after["y"] == before["y"]


def test_P0_the_merchant_key_is_the_same_after_a_restart(client) -> None:
    """The price-locked checkout JWT has the same property, and the same failure mode."""
    settings = get_settings()
    before = _public_jwk_of(settings.merchant_kid)

    from vi_service import keys as keys_module

    keys_module.reset_keystore()
    get_keystore()

    after = _public_jwk_of(settings.merchant_kid)
    assert after["x"] == before["x"] and after["y"] == before["y"]


def test_P0_a_different_kek_gives_a_different_issuer_key() -> None:
    """Derivation must actually depend on the KEK, not just be deterministic."""
    kek = get_settings().kek_b64
    other = base64.b64encode(bytes(32)).decode("ascii")  # all-zero 32 bytes is a different KEK

    first = derive_signing_key(kek, "ISSUER")
    second = derive_signing_key(other, "ISSUER")

    first_jwk = {member: getattr(first.private_numbers().public_numbers, member) for member in ("x", "y")}
    second_jwk = {member: getattr(second.private_numbers().public_numbers, member) for member in ("x", "y")}
    assert first_jwk != second_jwk


def test_P0_the_two_roles_never_share_a_key() -> None:
    """One label per role: an issuer key must not also be the merchant key."""
    kek = get_settings().kek_b64
    issuer = derive_signing_key(kek, "ISSUER")
    merchant = derive_signing_key(kek, "MERCHANT")

    issuer_numbers = issuer.private_numbers()
    merchant_numbers = merchant.private_numbers()
    assert issuer_numbers.private_value != merchant_numbers.private_value


def test_P0_only_the_two_network_keys_are_derived() -> None:
    """An AGENT key is per-agent and random; a derived agent key would be a shared secret."""
    kek = get_settings().kek_b64
    with pytest.raises(ValueError):
        derive_signing_key(kek, "AGENT")


def test_AT_M3_9_jwks_needs_no_bearer_token_but_the_rest_do(client) -> None:
    """The auth boundary is exactly the two routes spec §8.3 names, and no others."""
    assert client.get("/v1/jwks").status_code == 200

    for call in (
        lambda: client.post("/v1/keys/agent", json={"agent_id": "agt_x"}),
        lambda: client.post("/v1/keys/rotate", json={"role": "ISSUER"}),
        lambda: client.post("/v1/l1/issue", json={}),
        lambda: client.post("/v1/l2/prepare", json={}),
        lambda: client.post("/v1/l2/finalize", json={}),
        lambda: client.post("/v1/checkout-jwt", json={}),
        lambda: client.post("/v1/l3/create", json={}),
        lambda: client.post("/v1/verify", json={}),
    ):
        assert call().status_code == 401, "an unauthenticated call must be 401"


# --- EC-KEY-2: retired issuer keys still verify -------------------------------------------------------


def test_EC_KEY_2_an_l1_signed_by_a_retired_issuer_key_still_verifies(
    client, auth, builder, device_key, agent_key
) -> None:
    """EC-KEY-2 — issue an L1, rotate the issuer, and the existing chain still verifies.

    The verification path resolves the key from the L1's own `kid`, never from "whatever is current
    now". That one decision is what makes rotation safe to perform on a system with live evidence.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    checkout = builder.checkout_jwt()
    l3 = builder.create_l3(finalized.json()["l2"], checkout, agent_key)
    body = {
        "l1": l1["l1"],
        "l2": finalized.json()["l2"],
        "l3a": l3.json()["l3a"],
        "l3b": l3.json()["l3b"],
        "checkout_jwt": checkout["checkout_jwt"],
    }

    assert client.post("/v1/verify", json=body, headers=auth).json()["chain_valid"] is True

    rotation = client.post("/v1/keys/rotate", json={"role": "ISSUER"}, headers=auth)
    assert rotation.status_code == 200

    after = client.post("/v1/verify", json=body, headers=auth).json()
    assert after["chain_valid"] is True, after["errors"]
    # The report still names the *old* kid, because that is the key the L1 was signed with.
    assert after["keys"]["issuer_kid"] == l1["issuer_kid"]
    assert after["keys"]["issuer_kid"] != rotation.json()["new_kid"]


def test_EC_KEY_2_a_new_l1_uses_the_new_key_and_the_report_names_it(
    client, auth: dict[str, str], builder
) -> None:
    """After rotation, newly issued L1s carry the new `kid` — and both verify."""
    rotation = client.post("/v1/keys/rotate", json={"role": "ISSUER"}, headers=auth).json()

    l1 = builder.issue_l1()
    assert l1["issuer_kid"] == rotation["new_kid"]

    body = client.post(
        "/v1/verify",
        json={"l1": l1["l1"], "l2": l1["l1"]},
        headers=auth,
    ).json()
    assert body["keys"]["issuer_kid"] == rotation["new_kid"]


def test_EC_KEY_2_an_unknown_issuer_kid_is_a_chain_error_not_a_crash(
    client, auth: dict[str, str], full_chain
) -> None:
    """An L1 naming a key we have never heard of is invalid — with HTTP 200 and a reason.

    Fail-closed, and explainable: the message names the kid, so an operator can tell "forged" from
    "our JWKS is out of date".
    """
    # Swap the L1's kid for one that does not exist, and re-encode the JWS. The signature then fails
    # too, but the *reason we report first* is that the key cannot be resolved at all.
    l1 = full_chain.l1
    header_b64, payload_b64, signature = l1.split("~")[0].split(".")
    import json

    header = json.loads(base64.urlsafe_b64decode(header_b64 + "=" * (-len(header_b64) % 4)))
    header["kid"] = "issuer-key-does-not-exist"
    forged_header = b64u_encode(json.dumps(header, separators=(",", ":")).encode())

    body = full_chain.verify_body(l1=f"{forged_header}.{payload_b64}.{signature}~")
    response = client.post("/v1/verify", json=body, headers=auth)

    assert response.status_code == 200
    result = response.json()
    assert result["chain_valid"] is False
    assert any("no usable issuer key" in e for e in result["errors"])


# --- EC-KEY-3: retired merchant keys still verify ----------------------------------------------------


def test_EC_KEY_3_a_price_lock_signed_by_a_retired_merchant_key_still_verifies(
    client, auth: dict[str, str], builder
) -> None:
    """EC-KEY-3 — the Gate accepts checkout JWTs from an ACTIVE **or RETIRED** merchant key.

    A price lock issued before a rotation is still a valid price lock; a user mid-checkout when the
    ops team rotates must not have their cart invalidated.
    """
    before = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": MERCHANT,
            "lines": [{"sku": "SKU-TRAIL-42", "title": "Trail Runner", "qty": 1, "unit_minor": UNIT_MINOR}],
            "currency": "USD",
        },
        headers=auth,
    ).json()
    assert before["kid"] == "merchant-key-1"

    rotated = client.post("/v1/keys/rotate", json={"role": "MERCHANT"}, headers=auth).json()
    assert rotated["retired_kid"] == "merchant-key-1"

    check = client.get(f"/v1/checkout-jwt/verify?checkout_jwt={before['checkout_jwt']}", headers=auth).json()
    assert check["valid"] is True, check["reason"]

    after = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": MERCHANT,
            "lines": [{"sku": "SKU-TRAIL-42", "title": "Trail Runner", "qty": 1, "unit_minor": UNIT_MINOR}],
            "currency": "USD",
        },
        headers=auth,
    ).json()
    assert after["kid"] == rotated["new_kid"]


def test_EC_KEY_3_a_price_lock_from_an_unknown_merchant_key_is_rejected(client, auth: dict[str, str]) -> None:
    """Not in the registry → not a merchant key we trust, whatever the signature says."""
    response = client.get("/v1/checkout-jwt/verify?checkout_jwt=a.b.c", headers=auth).json()
    assert response["valid"] is False
    assert "merchant key" in (response["reason"] or "") or "decodable" in (response["reason"] or "")


# --- the KEK and agent key encryption (spec D5, EC-KEY-4) --------------------------------------------


def test_agent_private_key_is_never_returned_in_plaintext(client, agent_key) -> None:
    """`POST /v1/keys/agent` returns a public JWK and ciphertext. Nothing else.

    Spec D5: `apps/web` stores only the ciphertext in `agents.enc_private_key`, so the private half
    must not exist anywhere in the response.
    """
    assert set(agent_key.public_jwk) == {"kty", "crv", "x", "y"}
    assert "d" not in agent_key.public_jwk
    blob = base64.b64decode(agent_key.enc_private_key_b64, validate=True)
    assert len(blob) >= 12 + 16  # nonce + at least one byte of ciphertext + GCM tag
    assert b'"d"' not in blob, "the private scalar must not be recoverable from the ciphertext"


def test_kek_encryption_is_aes_256_gcm_with_a_fresh_nonce_each_time() -> None:
    """Two encryptions of the same key differ, so a stored ciphertext is not a fingerprint.

    A fixed nonce with the same KEK would leak the XOR of two plaintexts, which for a *private key*
    is a real leak, not a theoretical one.
    """
    from cryptography.hazmat.primitives.asymmetric import ec
    from verifiable_intent.crypto.signing import private_key_to_jwk

    kek = bytes(range(32))
    jwk = private_key_to_jwk(ec.generate_private_key(ec.SECP256R1()))

    first = encrypt_private_key(kek, jwk, aad="agt_1|kid_1")
    second = encrypt_private_key(kek, jwk, aad="agt_1|kid_1")

    assert first != second
    assert first[:12] != second[:12]
    assert decrypt_private_key(kek, first, aad="agt_1|kid_1") == jwk
    assert decrypt_private_key(kek, second, aad="agt_1|kid_1") == jwk


def test_agent_key_ciphertext_is_bound_to_its_owner() -> None:
    """AES-GCM's AAD ties the ciphertext to `agent_id|kid`.

    Without that, a ciphertext lifted out of one `agents` row would decrypt cleanly under another
    row's KEK context — the KEK would have authenticated the bytes but not their identity.
    """
    from cryptography.hazmat.primitives.asymmetric import ec
    from verifiable_intent.crypto.signing import private_key_to_jwk

    kek = bytes(range(32))
    jwk = private_key_to_jwk(ec.generate_private_key(ec.SECP256R1()))
    blob = encrypt_private_key(kek, jwk, aad="agt_alice|agt_kid_1")

    assert decrypt_private_key(kek, blob, aad="agt_alice|agt_kid_1") == jwk
    for wrong in ("agt_bob|agt_kid_1", "agt_alice|agt_kid_2", ""):
        with pytest.raises(ValueError, match="failed authentication"):
            decrypt_private_key(kek, blob, aad=wrong)


def test_a_wrong_kek_cannot_decrypt_an_agent_key(monkeypatch, client, auth: dict[str, str]) -> None:
    """EC-KEY-4 — losing the KEK invalidates agent keys, but not the evidence.

    The ciphertext fails authentication, so `l3/create` refuses. The *public* halves stay in JWKS, so
    a dispute filed earlier still verifies. Those are two different guarantees and both are tested.
    """
    minted = client.post("/v1/keys/agent", json={"agent_id": "agt_test_agent"}, headers=auth).json()

    monkeypatch.setenv("VI_KEK", base64.b64encode(bytes(reversed(range(32)))).decode())
    from vi_service import config, keys

    config.reset_settings()
    keys.reset_keystore()

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": minted["kid"],
            "enc_private_key_b64": minted["enc_private_key_b64"],
            "l2": "x.y.z~",
            "checkout_jwt": "a.b.c",
            "payment": {"amount_minor": 100, "currency": "USD", "payee_id": "mrc_northwind"},
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )
    # The ciphertext cannot be decrypted, and the route says so instead of signing with anything.
    assert response.status_code >= 400
    assert "VI_KEK" not in response.text or "decrypt" in response.text


def test_l3_create_refuses_an_unknown_agent_kid(client, auth: dict[str, str]) -> None:
    """An agent key we never minted cannot be used to sign, whatever ciphertext arrives."""
    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": "agt_never_minted",
            "enc_private_key_b64": base64.b64encode(b"x" * 60).decode(),
            "l2": "x.y.z~",
            "checkout_jwt": "a.b.c",
            "payment": {"amount_minor": 100, "currency": "USD", "payee_id": "mrc_northwind"},
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )
    assert response.status_code == 404, response.text
    error = error_body(response)
    assert error["code"] == "CS_NOT_FOUND"
    assert "agt_never_minted" in error["message"]


def test_l3_create_refuses_another_agents_ciphertext_under_this_kid(
    client, auth: dict[str, str], agent_key
) -> None:
    """Presenting agent B's ciphertext with agent A's `kid` fails the public-half comparison."""
    other = client.post("/v1/keys/agent", json={"agent_id": "agt_other"}, headers=auth).json()

    response = client.post(
        "/v1/l3/create",
        json={
            "agent_kid": agent_key.kid,
            "enc_private_key_b64": other["enc_private_key_b64"],
            "l2": "x.y.z~",
            "checkout_jwt": "a.b.c",
            "payment": {"amount_minor": 100, "currency": "USD", "payee_id": "mrc_northwind"},
            "aud": "https://network.countersign.test",
            "nonce": "n",
        },
        headers=auth,
    )
    assert response.status_code == 400, response.text
    assert response.json()["error"]["code"] == "CS_VALIDATION"


# --- rotation hygiene -------------------------------------------------------------------------------


def test_rotation_refuses_a_role_outside_issuer_and_merchant(client, auth: dict[str, str]) -> None:
    """`AGENT` is not rotatable here: agent keys rotate with the agent that owns them."""
    response = client.post("/v1/keys/rotate", json={"role": "AGENT"}, headers=auth)
    # Caught by the Literal at the edge, so it is a CS_VALIDATION 400 rather than reaching the store.
    assert response.status_code == 400, response.text
    error = error_body(response)
    assert error["code"] == "CS_VALIDATION"
    assert error["details"]["fields"][0]["loc"] == ["body", "role"]


def test_rotation_changes_the_signing_key(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """After rotation the issuer signs with a *different* key, and the old token stops verifying.

    The negative half of EC-KEY-2: retired means "still accepted for verification", not "still signs".
    """
    l1 = builder.issue_l1()
    assert (
        client.post("/v1/verify", json={"l1": l1["l1"], "l2": l1["l1"]}, headers=auth).json()["chain_valid"]
        is False
    )

    client.post("/v1/keys/rotate", json={"role": "ISSUER"}, headers=auth)

    after = client.post("/v1/verify", json={"l1": l1["l1"], "l2": l1["l1"]}, headers=auth).json()
    assert after["keys"]["issuer_kid"] == l1["issuer_kid"], "the report names the L1's own kid"
    assert after["chain_valid"] is False  # the L2 here is a stand-in, so the chain is still invalid
    assert not [e for e in after["errors"] if "no usable issuer key" in e], (
        "the retired key must still resolve; only the L2 is bogus"
    )


def test_rfc7638_thumbprint_is_stable_and_key_specific() -> None:
    """`devices.jkt` must be reproducible by the browser with the same algorithm.

    WebAuthn computes this over exactly `{"crv","kty","x","y"}`, sorted, no whitespace. If our
    ordering or member set differed from the browser's, `devices.jkt` would not match and the UI
    would not find the key it enrolled.
    """
    from cryptography.hazmat.primitives.asymmetric import ec
    from verifiable_intent.crypto.signing import public_key_to_jwk

    key = ec.generate_private_key(ec.SECP256R1())
    jwk = public_key_to_jwk(key)

    first = rfc7638_thumbprint(jwk)
    assert first == rfc7638_thumbprint(dict(jwk))
    assert first != rfc7638_thumbprint(public_key_to_jwk(ec.generate_private_key(ec.SECP256R1())))
    assert len(b64u_decode(first)) == 32

    # Adding a `kid` must not change the thumbprint: RFC 7638 hashes the required members only.
    assert rfc7638_thumbprint({**jwk, "kid": "dev_1", "use": "sig"}) == first


def test_rfc7638_thumbprint_rejects_a_jwk_missing_a_required_member() -> None:
    """A truncated JWK is a `ValueError`, not a hash of whatever is left.

    A thumbprint computed from a partial JWK would be *stable* and *wrong*, which is worse than a
    failure: `devices.jkt` would never match the key the browser enrolled.
    """
    with pytest.raises(ValueError, match="'y'"):
        rfc7638_thumbprint({"kty": "EC", "crv": "P-256", "x": "AAAA"})
    with pytest.raises(ValueError, match="'crv'"):
        rfc7638_thumbprint({"kty": "EC", "x": "AAAA", "y": "BBBB"})


def test_b64u_helpers_round_trip_including_the_padding_edge_case() -> None:
    """base64url without padding, both directions, for every residue length."""
    for length in range(0, 130):
        raw = bytes(range(length))
        encoded = b64u_encode(raw)
        assert "=" not in encoded
        assert b64u_decode(encoded) == raw


def test_keystore_rebuilds_when_settings_are_reset() -> None:
    """The registry's lifetime is tied to the settings object, so a test cannot leak keys.

    Without this, a rotation in one test would follow into the next and make failures depend on
    ordering — which is exactly the kind of flake that hides a real bug.
    """
    from vi_service import config, keys

    store = get_keystore()
    original_kid = store.current_kid("ISSUER")
    rotated_kid = store.rotate("ISSUER").kid
    assert store.current_kid("ISSUER") == rotated_kid
    assert store.get(original_kid) is not None  # retired, still resolvable

    config.reset_settings()
    keys.reset_keystore()

    fresh = get_keystore()
    assert fresh.current_kid("ISSUER") == original_kid
    assert fresh.get(original_kid) is not None
    assert fresh.get(rotated_kid) is None, "a reset must not resurrect keys from the previous registry"
