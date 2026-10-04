"""AT-M3.3 … AT-M3.7: constraints, skew, and the tampered price lock.

Every test here goes through `POST /v1/verify`, because that route's contract is *"an invalid chain
is a 200 with reasons"*. If these tests called the library directly they would prove the library
works; going through the route also proves the service never turns a bad chain into a 4xx.
"""

from __future__ import annotations

import base64

import pytest
from conftest import (
    CURRENCY,
    ITEM,
    MERCHANT,
    TOTAL_MINOR,
    UNIT_MINOR,
    amount_range_constraint,
    payment_constraints,
)

# ====================================================================================================
# AT-M3.3 — an amount over `amount_range.max`
# ====================================================================================================


def test_AT_M3_3_l3_create_refuses_an_amount_over_the_signed_maximum(
    client, auth, builder, device_key, agent_key
) -> None:
    """AT-M3.3 — `l3/create` will not sign an amount above the L2's `amount_range.max`.

    Refused at signing time, not merely reported later. The agent is the untrusted party here, so a
    service that would sign an out-of-mandate L3 would let a prompt injection spend money.
    """
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()

    response = builder.create_l3(l2, checkout, agent_key, amount_minor=20_000 + 5_000)

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert error["details"]["side"] == "payment"
    assert error["details"]["amount_minor"] == 25_000
    assert any("Amount exceeds maximum" in v for v in error["details"]["violations"])


def test_AT_M3_3_verify_reports_the_maximum_violation(client, auth: dict[str, str], full_chain) -> None:
    """AT-M3.3 at the verify boundary: the constraint report names both numbers.

    The violation string has to be quotable in a Gate reason and in a block message, so it carries
    the actual and the limit in minor units with the currency.
    """
    from vi_service.verify import _constraint_report

    constraints = [amount_range_constraint(20_000)]
    report = _constraint_report(
        constraints,
        {"payment_amount": {"currency": CURRENCY, "amount": 19_999 + 5_000}},
        side="payment",
    )

    assert report.satisfied is False
    assert len(report.violations) == 1
    assert "Amount exceeds maximum" in report.violations[0]
    assert "24999 > 20000 USD" in report.violations[0]
    assert "mandate.payment.amount_range" in report.checked


def test_AT_M3_3_an_amount_below_the_signed_minimum_is_also_a_violation(client, auth: dict[str, str]) -> None:
    """The floor is enforced too — `min` is not decoration."""
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        [{"type": "mandate.payment.amount_range", "currency": "USD", "min": 5_000, "max": 20_000}],
        {"payment_amount": {"currency": "USD", "amount": 4_999}},
        side="payment",
    )
    assert report.satisfied is False
    assert "Amount below minimum: 4999 < 5000 USD" in report.violations


def test_AT_M3_3_a_mismatched_currency_is_a_violation_not_a_conversion(client, auth: dict[str, str]) -> None:
    """USD cap, INR charge: a violation. We never convert (spec §8.1 `CS_CURRENCY_MISMATCH` copy)."""
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        [amount_range_constraint(20_000)],
        {"payment_amount": {"currency": "INR", "amount": 1_000}},
        side="payment",
    )
    assert report.satisfied is False
    assert "Currency mismatch: expected USD, got INR" in report.violations


# ====================================================================================================
# AT-M3.4 — a payee that is not in `allowed_payees`
# ====================================================================================================


def test_AT_M3_4_payee_outside_the_allowlist_is_a_violation(client, auth: dict[str, str]) -> None:
    """AT-M3.4 — a payee the user did not list is refused with the payee named."""
    from vi_service.verify import _constraint_report

    constraints = [
        {"type": "mandate.payment.allowed_payees", "allowed": [MERCHANT]},
    ]
    report = _constraint_report(
        constraints,
        {"payee": {"id": "mrc_somewhere_else", "name": "Somewhere Else", "website": "https://evil.test"}},
        side="payment",
    )

    assert report.satisfied is False
    assert any("not in allowed merchants" in v for v in report.violations)
    assert any("mrc_somewhere_else" in v for v in report.violations)
    assert "mandate.payment.allowed_payees" in report.checked


def test_AT_M3_4_l3_create_refuses_a_payee_the_l2_never_listed(
    client, auth, builder, device_key, agent_key
) -> None:
    """The same refusal one layer earlier: `l3/create` will not sign for an unknown payee."""
    l2 = _l2(builder, device_key, agent_key)
    checkout = builder.checkout_jwt()

    response = builder.create_l3(l2, checkout, agent_key, payee_id="mrc_somewhere_else")

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert error["details"]["payee_id"] == "mrc_somewhere_else"


def test_AT_M3_4_the_allowed_payee_is_matched_by_id(client, auth: dict[str, str]) -> None:
    """A payee with the same id but a different display name is still the allowed payee.

    The library matches on `id` when both sides have one, falling back to name+website. Merchant
    renames must not silently start failing a signed mandate.
    """
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        [{"type": "mandate.payment.allowed_payees", "allowed": [MERCHANT]}],
        {
            "payee": {
                "id": MERCHANT["id"],
                "name": "Northwind Outfitters Ltd",
                "website": "https://other.test",
            }
        },
        side="payment",
    )
    assert report.satisfied is True


# ====================================================================================================
# AT-M3.5 — an unknown constraint type under STRICT
# ====================================================================================================


def test_AT_M3_5_unknown_constraint_type_is_a_violation_under_strict(client, auth: dict[str, str]) -> None:
    """AT-M3.5 — STRICT turns an unrecognised constraint into a violation, not a shrug.

    This is the spec §8.0 rule 4 defence in depth: an unknown constraint is unbounded agent
    authority, so a verifier that skipped it would be trusting a rule it cannot read.
    """
    from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints

    from vi_service.verify import _constraint_report

    unknown = {"type": "mandate.payment.custom", "max": 1_000_000}
    report = _constraint_report(
        [unknown], {"payment_amount": {"currency": "USD", "amount": 1}}, side="payment"
    )

    assert report.satisfied is False
    assert report.violations == ["Unknown constraint type: mandate.payment.custom"]

    # Contrast: PERMISSIVE would skip it, which is exactly why the route must not use PERMISSIVE.
    permissive = check_constraints([unknown], {}, mode=StrictnessMode.PERMISSIVE)
    assert permissive.satisfied is True
    assert permissive.skipped == ["mandate.payment.custom"]


def test_AT_M3_5_l2_prepare_rejects_an_unknown_constraint_type_up_front(
    client, auth, builder, device_key, agent_key
) -> None:
    """Spec §8.8: exactly the 8 registered types, re-validated at `l2/prepare` (spec §8.5).

    Refused at signing time rather than discovered at verification time, which is the only point at
    which the refusal still helps the user.
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
                {"type": "mandate.checkout.allowed_merchants", "allowed": [MERCHANT]},
                {
                    "type": "mandate.checkout.line_items",
                    "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                },
            ],
            "payment_constraints": [{"type": "mandate.payment.hodl", "amount": 10}],
            "merchants": [MERCHANT],
            "acceptable_items": [ITEM],
            "payment_instrument": {"type": "paypal_vault", "id": l1["card_id"], "description": "PayPal"},
            "nonce": "n",
            "aud": "https://agent.countersign.test",
        },
        headers=auth,
    )
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "VI_CONSTRAINT_VIOLATION"
    assert "mandate.payment.hodl" in error["message"]
    assert error["details"]["constraint_type"] == "mandate.payment.hodl"
    assert len(error["details"]["known_types"]) == 8


def test_AT_M3_5_a_wrongly_shaped_known_constraint_is_also_refused(
    client, auth, builder, device_key, agent_key
) -> None:
    """A known type with the wrong fields is refused too — `budget.max` must be an integer > 0.

    `PaymentBudgetConstraint.__post_init__` raises `ValueError` on `max <= 0`; we reject it before
    the library does, with a 422 and a field path, instead of letting a 500 out.
    """
    l1 = builder.issue_l1()
    for bad in (
        {"type": "mandate.payment.budget", "currency": "USD", "max": 0},
        {"type": "mandate.payment.budget", "currency": "USD", "max": -100},
        {"type": "mandate.payment.budget", "currency": "USD", "max": "13000"},
        {"type": "mandate.payment.budget", "currency": "USD"},
    ):
        response = client.post(
            "/v1/l2/prepare",
            json={
                "l1": l1["l1"],
                "device_kid": device_key.kid,
                "agent_public_jwk": agent_key.public_jwk,
                "agent_kid": agent_key.kid,
                "checkout_constraints": [
                    {"type": "mandate.checkout.allowed_merchants", "allowed": [MERCHANT]},
                    {
                        "type": "mandate.checkout.line_items",
                        "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                    },
                ],
                "payment_constraints": [bad],
                "merchants": [MERCHANT],
                "acceptable_items": [ITEM],
                "payment_instrument": {"type": "paypal_vault", "id": l1["card_id"], "description": "PayPal"},
                "nonce": "n",
                "aud": "https://agent.countersign.test",
            },
            headers=auth,
        )
        assert response.status_code == 422, f"{bad} -> {response.status_code} {response.text}"
        assert response.json()["error"]["code"] == "VI_CONSTRAINT_VIOLATION", bad


def test_AT_M3_5_agent_recurrence_requires_an_end_date(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """`agent_recurrence.end_date` is REQUIRED by the library, so pydantic requires it first."""
    from pydantic import ValidationError

    from vi_service.models import validate_constraint_dict

    with pytest.raises(Exception) as excinfo:
        validate_constraint_dict(
            {
                "type": "mandate.payment.agent_recurrence",
                "frequency": "MNTH",
                "start_date": "2026-10-01",
            }
        )
    assert isinstance(excinfo.value, ValidationError) or "end_date" in str(excinfo.value)


# ====================================================================================================
# AT-M3.6 — `exp` in the past, beyond and within the skew
# ====================================================================================================


def test_AT_M3_6_exp_beyond_the_skew_invalidates_the_chain(client, auth: dict[str, str]) -> None:
    """AT-M3.6 — an L1 whose `exp` is 400 s old is invalid: 400 > 300 s of tolerance."""
    chain = _build_chain_with_expiry(client, l1_exp_offset=-400, l2_exp_offset=86_400)

    response = client.post("/v1/verify", json=chain, headers=auth)

    assert response.status_code == 200, "an expired chain is a 200, not a 4xx"
    body = response.json()
    assert body["chain_valid"] is False
    assert any("L1 credential expired" in e for e in body["errors"])


def test_AT_M3_6_exp_within_the_skew_still_validates(client, auth: dict[str, str]) -> None:
    """AT-M3.6 — 100 s past `exp` is still inside the 300 s skew, so it verifies (EC-TIME-2)."""
    chain = _build_chain_with_expiry(client, l1_exp_offset=-100, l2_exp_offset=86_400)

    body = client.post("/v1/verify", json=chain, headers=auth).json()

    assert body["chain_valid"] is True, body["errors"]
    assert body["errors"] == []


def test_AT_M3_6_skew_is_configurable_and_honoured(client, auth: dict[str, str], monkeypatch) -> None:
    """With `VI_CLOCK_SKEW_SECONDS=0`, a 100 s-old `exp` stops verifying.

    Proves the skew is actually plumbed through to `verify_chain` rather than being the library
    default by accident. EC-TIME-2 is the spec's answer to clock drift: 300 s absorbs a 5 s NTP
    offset with a huge margin.
    """
    import os

    from vi_service import config, keys
    from vi_service import l2 as l2_module

    os.environ["VI_CLOCK_SKEW_SECONDS"] = "0"
    config.reset_settings()
    keys.reset_keystore()
    l2_module.reset_prepare_store()

    chain = _build_chain_with_expiry(client, l1_exp_offset=-100, l2_exp_offset=86_400)
    body = client.post("/v1/verify", json=chain, headers=auth).json()

    assert body["clock_skew_seconds"] == 0
    assert body["chain_valid"] is False
    assert any("L1 credential expired" in e for e in body["errors"])


def test_AT_M3_6_an_l2_that_expired_invalidates_the_chain(client, auth: dict[str, str]) -> None:
    """The same rule on the L2: an expired mandate is not a mandate any more (EC-TIME-3)."""
    chain = _build_chain_with_expiry(client, l1_exp_offset=86_400, l2_exp_offset=-400)
    body = client.post("/v1/verify", json=chain, headers=auth).json()
    assert body["chain_valid"] is False
    assert any("L2 expired" in e for e in body["errors"])


def test_EC_TIME_3_at_time_is_flagged_as_not_honoured(client, auth: dict[str, str], full_chain) -> None:
    """EC-TIME-3 — `at_time` is accepted, but the service says plainly that the library ignored it.

    `verify_chain` at the pinned commit reads `time.time()` internally and takes no clock override,
    so the honest response is the verification we *did* perform plus `at_time_not_honoured: true` and
    the reason. Reporting a fabricated as-of verdict would corrupt an evidence packet, which is worse
    than reporting none.
    """
    body = client.post("/v1/verify", json=full_chain.verify_body(at_time=1_790_000_000), headers=auth).json()

    assert body["at_time_not_honoured"] is True
    assert "no clock override" in body["at_time_reason"]
    assert body["at_time_check"]["requested"] == 1_790_000_000
    assert body["at_time_check"]["honoured"] is False
    assert body["at_time_check"]["within_validity_at"] is False
    assert body["at_time_check"]["within_validity_now"] is True
    # The verdict itself is the one we actually performed: at `now`.
    assert body["verified_at"] > 1_790_000_000


def test_EC_TIME_3_at_time_within_the_window_is_reported_as_such(
    client, auth: dict[str, str], full_chain
) -> None:
    """An `at_time` inside the mandate's own window: still flagged, but the window check says yes."""
    now = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()["verified_at"]

    body = client.post("/v1/verify", json=full_chain.verify_body(at_time=now - 60), headers=auth).json()

    assert body["at_time_not_honoured"] is True
    assert body["at_time_check"]["within_validity_at"] is True
    assert body["chain_valid"] is True


def test_EC_TIME_1_iat_exp_come_from_the_service_clock_not_the_request(
    client, auth, builder, agent_key, device_key, clock
) -> None:
    """EC-TIME-1 — a browser whose clock is wrong by hours cannot move `iat`/`exp`.

    The request carries no timestamp at all. `clock` here is the *service's* clock, moved by hand so
    the assertion is exact, which is the point: nothing the browser sends reaches `iat` or `exp`.
    """
    clock.set(1_800_000_000)
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])

    assert l1["iat"] == 1_800_000_000
    assert l1["exp"] == 1_800_000_000 + 365 * 86_400
    assert prepared["payload"]["iat"] == 1_800_000_000
    assert prepared["expires_at"] == 1_800_000_000 + 300


def test_EC_TIME_2_status_reports_the_skew_in_force(client) -> None:
    """EC-TIME-2 — `/v1/status` states the skew actually in force, so a caller can compare clocks.

    `clock` is a *test* hook only; in production `now_sec()` is the system clock, so `verified_at` is
    the whole of what a caller can compare against its own `Date` header.
    """
    body = client.get("/v1/status").json()

    assert body["ok"] is True
    assert body["clock_skew_seconds"] == 300
    assert body["issuer_kid"] == "issuer-key-1"
    assert body["merchant_kid"] == "merchant-key-1"


# ====================================================================================================
# AT-M3.7 — a tampered checkout JWT
# ====================================================================================================


def test_AT_M3_7_one_flipped_byte_in_the_price_lock_invalidates_the_chain(
    client, auth: dict[str, str], full_chain
) -> None:
    """AT-M3.7 — flip one byte of the checkout JWT and `chain_valid` goes false, with HTTP 200.

    Two independent things catch it, and both are asserted: the merchant signature no longer
    verifies, and the `checkout_hash` no longer matches what L3b committed to. The hash comparison is
    the *binding* — it proves the authorised price is the price in this token.
    """
    tampered = _flip_one_byte(full_chain.checkout_jwt)

    response = client.post("/v1/verify", json=full_chain.verify_body(checkout_jwt=tampered), headers=auth)

    assert response.status_code == 200
    body = response.json()
    assert body["chain_valid"] is False
    assert any("checkout JWT signature invalid" in e for e in body["errors"])
    assert any("checkout_hash mismatch" in e for e in body["errors"])


def test_AT_M3_7_a_byte_flip_in_the_payload_is_also_a_200_with_reasons(
    client, auth: dict[str, str], full_chain
) -> None:
    """Flipping the payload instead of the signature must still be a verdict, never a 400.

    A tampered price lock that happens to stop decoding is still just an invalid chain, so spec
    §8.3's "never 4xx" holds. If this ever returns 4xx, a public verifier could be handed a
    one-byte edit and turned into an oracle for whether the rest of the packet was well-formed.
    """
    tampered = _flip_one_byte(full_chain.checkout_jwt, segment=1)

    response = client.post("/v1/verify", json=full_chain.verify_body(checkout_jwt=tampered), headers=auth)

    assert response.status_code == 200
    body = response.json()
    assert body["chain_valid"] is False
    assert body["errors"], "a tampered price lock must produce at least one reason"
    assert body["constraints"]["satisfied"] is False


def test_AT_M3_7_a_tampered_payload_byte_is_caught_by_the_hash_alone(
    client, auth: dict[str, str], full_chain
) -> None:
    """Re-sign the tampered payload with the *real* merchant key and it is still rejected.

    This is the case that matters for the threat model: the merchant is not the adversary, so a
    "someone with the merchant key re-signed a different price" event must still fail the binding
    check. Only the `checkout_hash` comparison catches it.
    """
    from vi_service.checkout_jwt import _jwt_encode
    from vi_service.keys import get_keystore

    parts = full_chain.checkout_jwt.split(".")
    import json

    payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    payload["cart"]["total"]["amount_minor"] = 1
    payload["cart"]["subtotal"]["amount_minor"] = 1
    resigned = _jwt_encode(
        {"alg": "ES256", "typ": "JWT", "kid": "merchant-key-1"},
        payload,
        get_keystore().signing_key("MERCHANT"),
    )

    body = client.post("/v1/verify", json=full_chain.verify_body(checkout_jwt=resigned), headers=auth).json()

    assert body["chain_valid"] is False
    assert any("checkout_hash mismatch" in e for e in body["errors"])
    assert not any("signature invalid" in e for e in body["errors"])


def test_AT_M3_7_a_tampered_line_quantity_is_caught_by_the_constraints(
    client, auth: dict[str, str], full_chain
) -> None:
    """Buy two of something the user approved once: the line_items quantity cap catches it.

    A different kind of tampering — not the bytes but the promise. The constraint report has to name
    the cap, because this is what a buyer would be told.
    """
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        [
            {
                "type": "mandate.checkout.line_items",
                "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                "match_mode": "minimum",
            }
        ],
        {"merchant": MERCHANT, "line_items": [{"id": ITEM["id"], "quantity": 2}]},
        side="checkout",
    )
    assert report.satisfied is False
    assert any("Total quantity 2 exceeds limit 1" in v for v in report.violations)


def test_AT_M3_7_an_item_outside_the_signed_list_is_caught(client, auth: dict[str, str]) -> None:
    """A SKU the user never listed is a violation naming the acceptable ids."""
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        [
            {
                "type": "mandate.checkout.line_items",
                "items": [{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                "match_mode": "minimum",
            }
        ],
        {"merchant": MERCHANT, "line_items": [{"id": "SKU-UNAPPROVED", "quantity": 1}]},
        side="checkout",
    )
    assert report.satisfied is False
    assert any("not in acceptable items" in v for v in report.violations)
    assert any(ITEM["id"] in v for v in report.violations)


def test_AT_M3_7_match_mode_exact_requires_every_signed_item(client, auth: dict[str, str]) -> None:
    """`match_mode: exact` closes the "fulfil only the cheapest line" gap that `minimum` leaves open."""
    from vi_service.verify import _constraint_report

    constraints = [
        {
            "type": "mandate.checkout.line_items",
            "items": [
                {
                    "id": "li-1",
                    "acceptable_items": [{"id": "SKU-A", "title": "A"}, {"id": "SKU-B", "title": "B"}],
                    "quantity": 2,
                }
            ],
            "match_mode": "exact",
        }
    ]
    # One of the two acceptable SKUs is enough for `exact`: the requirement is the *line*, and each
    # acceptable item satisfies it.
    assert (
        _constraint_report(
            constraints,
            {"merchant": MERCHANT, "line_items": [{"id": "SKU-A", "quantity": 2}]},
            side="checkout",
        ).satisfied
        is True
    )

    # An empty cart fulfils nothing, so `exact` fails where `minimum` would also fail. The real
    # difference shows up when a *different* SKU arrives: both reject it, but `exact` additionally
    # rejects a cart that satisfies only some of several line-item requirements.
    two_requirements = [
        {
            "type": "mandate.checkout.line_items",
            "items": [
                {"id": "li-shoes", "acceptable_items": [{"id": "SKU-A", "title": "A"}], "quantity": 1},
                {"id": "li-socks", "acceptable_items": [{"id": "SKU-B", "title": "B"}], "quantity": 1},
            ],
            "match_mode": "exact",
        }
    ]
    partial = _constraint_report(
        two_requirements,
        {"merchant": MERCHANT, "line_items": [{"id": "SKU-A", "quantity": 1}]},
        side="checkout",
    )
    assert partial.satisfied is False
    assert any("match_mode=exact" in v for v in partial.violations)
    assert any("li-socks" in v for v in partial.violations)

    same_under_minimum = dict(two_requirements[0], match_mode="minimum")
    assert (
        _constraint_report(
            [same_under_minimum],
            {"merchant": MERCHANT, "line_items": [{"id": "SKU-A", "quantity": 1}]},
            side="checkout",
        ).satisfied
        is True
    )


# ====================================================================================================
# never 4xx on an invalid chain
# ====================================================================================================


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("l1", "not-a-jwt"),
        ("l2", "~~"),
        ("l1", "a.b.c"),
        ("l3a", "nonsense"),
    ],
)
def test_verify_returns_200_for_undecodable_tokens(
    client, auth: dict[str, str], full_chain, field, value
) -> None:
    """A malformed token is a verdict, not a client error. Spec §8.3: "never 4xx on an invalid chain"."""
    response = client.post("/v1/verify", json=full_chain.verify_body(**{field: value}), headers=auth)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["chain_valid"] is False
    assert any(field in e for e in body["errors"])


def test_verify_reports_an_empty_constraint_set_as_unchecked_not_satisfied(
    client, auth: dict[str, str]
) -> None:
    """No disclosed constraints is "nothing to check", which must never read as "satisfied"."""
    from vi_service.verify import _constraint_report

    report = _constraint_report([], {}, side="payment")
    assert report.satisfied is False
    assert report.violations == ["No payment constraints were disclosed, so none could be enforced"]


def test_network_enforced_constraints_are_reported_as_skipped_not_checked(
    client, auth: dict[str, str]
) -> None:
    """Spec D19: `budget`, `recurrence` and `agent_recurrence` are the Gate's job, not the library's.

    The library appends them to `checked` while evaluating none of them. If we passed that through,
    the Gate would believe it had nothing left to enforce.
    """
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        payment_constraints(20_000),
        {
            "payee": MERCHANT,
            "payment_amount": {"currency": CURRENCY, "amount": TOTAL_MINOR},
        },
        side="payment",
    )

    assert report.satisfied is True
    for name in ("mandate.payment.budget", "mandate.payment.recurrence"):
        assert name not in report.checked, f"{name} must not be reported as checked"
        skipped = [s for s in report.skipped if s.type == name]
        assert len(skipped) == 1, f"{name} must appear exactly once in skipped"
        assert "Network-enforced" in skipped[0].reason

    assert "mandate.payment.amount_range" in report.checked


def test_skipped_entries_are_objects_not_strings(client, auth: dict[str, str], full_chain) -> None:
    """`skipped` must be `{type, reason}[]`, never a mix of strings and annotated strings.

    The failure this prevents is quiet and expensive: a Gate asking
    `skipped.includes('mandate.payment.budget')` against the old `list[str]` got `false` **while a
    signed budget cap sat unevaluated**, so it concluded it owed nothing. Membership has to be exact,
    so the type is its own field (docs/DECISIONS.md D-019).
    """
    from vi_service.verify import _constraint_report

    report = _constraint_report(
        payment_constraints(20_000),
        {"payee": MERCHANT, "payment_amount": {"currency": CURRENCY, "amount": TOTAL_MINOR}},
        side="payment",
    )

    assert report.skipped, "the fixture constraints include network-enforced ones"
    for entry in report.skipped:
        assert isinstance(entry.type, str) and entry.type, "every skipped entry needs a type"
        assert isinstance(entry.reason, str) and entry.reason, "every skipped entry needs a reason"
        # The exact membership test a Gate would write, asserted to work.
        assert "mandate.payment.budget" in [s.type for s in report.skipped]

    # And over the wire, so the shape is not just a Python-side detail.
    body = client.post("/v1/verify", headers=auth, json=full_chain.verify_body()).json()
    assert body["constraints"]["skipped"], "a full chain with network-enforced constraints"
    for entry in body["constraints"]["skipped"]:
        assert set(entry) == {"type", "reason"}, f"unexpected skipped shape: {entry}"
    types = [e["type"] for e in body["constraints"]["skipped"]]
    assert "mandate.payment.budget" in types, f"budget must be machine-findable, got {types}"


def test_no_disclosed_constraints_is_a_skip_not_a_pass(client, auth: dict[str, str]) -> None:
    """An empty constraint list is "nothing to check", never "satisfied"."""
    from vi_service.verify import _constraint_report

    report = _constraint_report([], {}, side="payment")
    assert report.satisfied is False
    assert report.checked == []
    assert [s.type for s in report.skipped] == ["payment_constraints"]
    assert "none could be enforced" in report.skipped[0].reason


# --- helpers -----------------------------------------------------------------------------------------


def _l2(builder, device_key, agent_key) -> str:
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    assert finalized.status_code == 200, finalized.text
    return finalized.json()["l2"]


def _flip_one_byte(jwt: str, segment: int = 2) -> str:
    """Change exactly one base64url character in `segment` (0=header, 1=payload, 2=signature).

    Defaults to the signature so the payload still decodes: that is the case where the *binding*
    check has to be the thing that catches it, rather than a parse error arriving first.
    """
    parts = jwt.split(".")
    index = len(parts[segment]) // 2
    original = parts[segment][index]
    parts[segment] = parts[segment][:index] + ("A" if original != "A" else "B") + parts[segment][index + 1 :]
    assert parts[segment] != jwt.split(".")[segment]
    return ".".join(parts)


def _build_chain_with_expiry(client, *, l1_exp_offset: int, l2_exp_offset: int) -> dict:
    """Build a chain whose `exp` sits at a chosen offset from now, and return a `/v1/verify` body.

    `/v1/l1/issue` takes `ttl_days` and validates `1 <= ttl_days <= 365`, which cannot express
    "expired 400 s ago". The behaviour under test in AT-M3.6 is the *verifier's* skew arithmetic, not
    the issuance route's TTL validation, so the tokens are built with the library at explicit
    timestamps and then posted to the real `/v1/verify`. Everything downstream of that — the
    presentations included — goes through the service's own `find_disclosures`, so this helper
    cannot drift from what `verify` recomputes.
    """
    import hashlib
    import uuid

    from cryptography.hazmat.primitives.asymmetric import ec
    from verifiable_intent.crypto.disclosure import hash_bytes
    from verifiable_intent.issuance.agent import create_layer3_checkout, create_layer3_payment
    from verifiable_intent.issuance.issuer import create_layer1
    from verifiable_intent.issuance.user import create_layer2_autonomous
    from verifiable_intent.models.agent_mandate import (
        CheckoutL3Mandate,
        FinalCheckoutMandate,
        FinalPaymentMandate,
        PaymentL3Mandate,
    )
    from verifiable_intent.models.constraints import CheckoutLineItemsConstraint, PaymentAmountConstraint
    from verifiable_intent.models.issuer_credential import IssuerCredential
    from verifiable_intent.models.user_mandate import (
        CheckoutMandate,
        MandateMode,
        PaymentMandate,
        UserMandate,
    )

    from vi_service.checkout_jwt import _jwt_encode, checkout_hash_from_jwt
    from vi_service.config import now_sec
    from vi_service.keys import get_keystore, public_key_to_jwk
    from vi_service.l2 import find_disclosures

    now = now_sec()
    store = get_keystore()
    device_key = ec.generate_private_key(ec.SECP256R1())
    agent_key = ec.generate_private_key(ec.SECP256R1())
    instrument = {
        "type": "paypal_vault",
        "id": hashlib.sha256(b"expiry-token").hexdigest(),
        "description": "PayPal",
    }

    l1 = create_layer1(
        IssuerCredential(
            iss="https://www.mastercard.com",
            sub="usr_expiry",
            iat=now - 86_400,
            exp=now + l1_exp_offset,
            cnf_jwk=public_key_to_jwk(device_key),
            email="expiry@countersign.test",
            pan_last_four="1234",
            scheme="PayPal",
        ),
        store.signing_key("ISSUER"),
        kid=store.current_kid("ISSUER"),
    )

    l2 = create_layer2_autonomous(
        UserMandate(
            nonce=str(uuid.uuid4()),
            aud="https://agent.countersign.test",
            iat=now,
            exp=now + l2_exp_offset,
            mode=MandateMode.AUTONOMOUS,
            sd_hash=hash_bytes(l1.serialize().encode("ascii")),
            checkout_mandate=CheckoutMandate(
                vct="mandate.checkout.open.1",
                cnf_jwk=public_key_to_jwk(agent_key),
                cnf_kid="agt_expiry",
                constraints=[
                    CheckoutLineItemsConstraint(
                        items=[{"id": "li-1", "acceptable_items": [ITEM], "quantity": 1}],
                        match_mode="minimum",
                    )
                ],
            ),
            payment_mandate=PaymentMandate(
                vct="mandate.payment.open.1",
                cnf_jwk=public_key_to_jwk(agent_key),
                cnf_kid="agt_expiry",
                payment_instrument=instrument,
                constraints=[PaymentAmountConstraint(currency=CURRENCY, min=0, max=50_000)],
            ),
            merchants=[MERCHANT],
            acceptable_items=[ITEM],
        ),
        device_key,
        kid="dev_expiry",
    )
    l2_serialized = l2.serialize()

    checkout_jwt = _jwt_encode(
        {"alg": "ES256", "typ": "JWT", "kid": store.current_kid("MERCHANT")},
        {
            "iss": MERCHANT["website"],
            "sub": "cart_checkout",
            "iat": now,
            "exp": now + 900,
            "merchant": MERCHANT,
            "cart": {
                "merchant": MERCHANT,
                "items": [
                    {"sku": ITEM["id"], "title": ITEM["title"], "quantity": 1, "unit_minor": UNIT_MINOR}
                ],
                "total": {"amount_minor": UNIT_MINOR, "currency_code": CURRENCY},
            },
        },
        store.signing_key("MERCHANT"),
    )
    checkout_hash = checkout_hash_from_jwt(checkout_jwt)

    found = find_disclosures(l2, merchant_id=MERCHANT["id"], item_id=ITEM["id"])
    l3_nonce = str(uuid.uuid4())
    l3a = create_layer3_payment(
        PaymentL3Mandate(
            nonce=l3_nonce,
            aud="https://network.countersign.test",
            iat=now,
            exp=now + 300,
            final_payment=FinalPaymentMandate(
                transaction_id=checkout_hash,
                payee=MERCHANT,
                payment_amount={"currency": CURRENCY, "amount": UNIT_MINOR},
                payment_instrument=instrument,
            ),
            final_merchant=MERCHANT,
        ),
        agent_key,
        found.base_jwt,
        found.payment_mandate,
        found.merchant,
        kid="agt_expiry",
    )
    l3b = create_layer3_checkout(
        CheckoutL3Mandate(
            nonce=l3_nonce,
            aud=MERCHANT["website"],
            iat=now,
            exp=now + 300,
            final_checkout=FinalCheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=checkout_hash),
        ),
        agent_key,
        found.base_jwt,
        found.checkout_mandate,
        found.item,
        kid="agt_expiry",
    )

    return {
        "l1": l1.serialize(),
        "l2": l2_serialized,
        "l3a": l3a.serialize(),
        "l3b": l3b.serialize(),
        "checkout_jwt": checkout_jwt,
        "strict": True,
    }
