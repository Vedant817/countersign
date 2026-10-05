"""QA2-VI-1: the presented SD-JWT disclosures must be complete, and the refusal must be a 200.

The defect this file exists for
-------------------------------
A JWS signature covers `header.payload` and nothing else. SD-JWT disclosures live after the `~`, so
**the presenting party chooses which disclosures travel with the token** — and per spec §3.1 that
party is the agent, the untrusted one. SD-JWT itself guarantees nothing about completeness: the
signed payload commits to `hash(merchant)`, and no library check requires that disclosure to be
*present*.

Three layers each failed open, and all three had to be fixed:

1. ``vi_service.l2.resolve_disclosure_refs`` returned the **unresolved reference itself** on a miss,
   so ``allowed_payees: [{"...": hash}]`` reached the checker instead of failing.
2. ``constraint_checker._check_allowed_payee`` (and ``_check_allowed_merchant``) treat "every entry
   is an SD ref" as *skip and pass*: they append ``"<type> (skipped: no resolved payees)"`` to
   ``checked`` and return with ``satisfied`` still true.
3. ``l2.find_disclosures`` picked the merchant **by position** while ``resolve_disclosure_refs``
   picked **by hash** — two different selections, so the sanity check passed while enforcement was
   blind.

Measured before the fix (same L3a bytes, same payee, one disclosure different):

    BASELINE  chain_valid = False  violations = ['Payee ... (id=mrc_evil) not in allowed merchants']
    A1        chain_valid = True   violations = []

Every test here asserts the opposite, on **both** routes, and asserts that an invalid chain is still
a **200 with an honest verdict** — the public verifier is the thing a judge is pointed at, so a
verifier that 500s or 4xxs on bad evidence is not usable (spec §8.3, and this module's own
``verify.py`` contract).

The chain builders below are deliberately built on the **real routes** (``/v1/l1/issue``,
``/v1/l2/prepare``, ``/v1/l2/finalize``, ``/v1/checkout-jwt``) and then attack the result, because a
test that assembles its own L2 would be testing its own assembly.
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import (
    AGENT_ID,
    CURRENCY,
    ITEM,
    SERVICE_TOKEN,
    SHIPPING_MINOR,
    TAX_MINOR,
    UNIT_MINOR,
)
from verifiable_intent.crypto.disclosure import decode_disclosure, hash_disclosure
from verifiable_intent.crypto.sd_jwt import decode_sd_jwt

from vi_service import config, keys, ratelimit
from vi_service import l2 as vi_l2

#: The payee the attacker will actually name on the L3a. Never authorised by the buyer, never present
#: in any mandate. This is the whole point: `chain_valid: true` here is money to somebody the buyer
#: did not consent to pay.
EVIL_PAYEE = {
    "id": "mrc_evil",
    "name": "Totally Legit Store",
    "website": "https://evil.example",
}

#: The only payee in `allowed_payees`. So if the allow-list is enforced, this payment is refused.
AUTHORISED_PAYEE = {
    "id": "mrc_beta",
    "name": "Beta Goods",
    "website": "https://beta.countersign.test",
}

#: The visible shop: what the checkout JWT is signed for and what `allowed_merchants` names. Carried
#: by the mandate so `find_disclosures` finds *a* merchant and does not refuse — that is what makes
#: the narrow-presentation attack reachable at all.
VISIBLE_MERCHANT = {
    "id": "mrc_alpha",
    "name": "Alpha Outfitters",
    "website": "https://alpha.countersign.test",
}

TOTAL_MINOR = UNIT_MINOR + SHIPPING_MINOR + TAX_MINOR

AUTH = {"Authorization": f"Bearer {SERVICE_TOKEN}"}


# ====================================================================================================
# builders
# ====================================================================================================


class Chain:
    """The tokens of one fully-signed chain, plus the L2 strings to attack it with."""

    def __init__(
        self,
        *,
        l1: str,
        l2: str,
        l3a: str,
        l3b: str,
        checkout_jwt: str,
        card_id: str,
        agent: dict[str, str],
    ) -> None:
        self.l1 = l1
        self.l2 = l2
        self.l3a = l3a
        self.l3b = l3b
        self.checkout_jwt = checkout_jwt
        self.card_id = card_id
        self.agent = agent

    def verify_body(self, **overrides: Any) -> dict[str, Any]:  # noqa: ANN401 - JSON request body
        body: dict[str, Any] = {
            "l1": self.l1,
            "l2": self.l2,
            "l3a": self.l3a,
            "l3b": self.l3b,
            "checkout_jwt": self.checkout_jwt,
        }
        body.update(overrides)
        return body

    def public_body(self, l2: str | None = None) -> dict[str, Any]:
        """The `/v1/public/verify` request. **No Authorization header** — that is the point of it."""
        return {"bundle": self.verify_body(l2=l2)}


def _build(
    client,
    auth: dict[str, str],
    device_key,
    *,
    merchants: list[dict[str, str]],
    allowed_payees: list[dict[str, str]],
    checkout_allowed: list[dict[str, str]],
    checkout_merchant: dict[str, str],
    forge_payee: dict[str, str],
) -> Chain:
    """A complete, valid chain through the real routes, with an agent-signed L3 naming `forge_payee`.

    The L3 is forged rather than minted by `l3/create` on purpose: `l3/create` refuses a payee that
    is not in the L2 (a property this suite must not disturb), so the only way to reach the
    *verification* path with an unauthorised payee is to sign it with the agent key — which is
    precisely the threat model, since the agent holds that key (spec §3.1).
    """
    agent = client.post("/v1/keys/agent", json={"agent_id": AGENT_ID}, headers=auth).json()

    l1 = client.post(
        "/v1/l1/issue",
        json={
            "user_id": "usr_test_user",
            "wallet": {
                "payer_id": "PAYER123",
                "payer_email": "buyer@countersign.test",
                "payment_token_id": "vault-token-abc123",
            },
            "device_public_jwk": device_key.public_jwk,
            "device_kid": device_key.kid,
            "ttl_days": 365,
        },
        headers=auth,
    ).json()

    prepared = client.post(
        "/v1/l2/prepare",
        json={
            "l1": l1["l1"],
            "device_kid": device_key.kid,
            "agent_public_jwk": agent["public_jwk"],
            "agent_kid": agent["kid"],
            "checkout_constraints": [
                {"type": "mandate.checkout.allowed_merchants", "allowed": checkout_allowed},
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
                    "max": 20_000,
                },
                {"type": "mandate.payment.allowed_payees", "allowed": allowed_payees},
            ],
            "merchants": merchants,
            "acceptable_items": [ITEM],
            "payment_instrument": {
                "type": "paypal_vault",
                "id": l1["card_id"],
                "description": "PayPal - 1234",
            },
            "nonce": "nonce-disclosure-test",
            "aud": "https://agent.countersign.test",
            "ttl_seconds": 86_400,
        },
        headers=auth,
    )
    assert prepared.status_code == 200, prepared.text
    prepared = prepared.json()

    finalized = client.post(
        "/v1/l2/finalize",
        json={
            "prepare_id": prepared["prepare_id"],
            "signature_b64url": device_key.sign(prepared["signing_input"]),
        },
        headers=auth,
    )
    assert finalized.status_code == 200, finalized.text
    l2 = finalized.json()["l2"]

    checkout = client.post(
        "/v1/checkout-jwt",
        json={
            "merchant": checkout_merchant,
            "lines": [
                {
                    "sku": ITEM["id"],
                    "title": ITEM["title"],
                    "qty": 1,
                    "unit_minor": UNIT_MINOR,
                }
            ],
            "shipping_minor": SHIPPING_MINOR,
            "tax_minor": TAX_MINOR,
            "currency": CURRENCY,
            "ttl_seconds": 900,
            "checkout_id": "chk_disclosure_test",
        },
        headers=auth,
    ).json()

    # The L3, signed with the agent key. Same library calls and the same disclosure selection as
    # `vi_service.l3.create_l3`, so the `sd_hash` bindings are legitimate and the chain is genuinely
    # valid — the only illegitimate thing in it is the payee, which is the point.
    l3a, l3b = _forge_l3(
        l2=l2,
        card_id=l1["card_id"],
        checkout_jwt=checkout["checkout_jwt"],
        checkout_hash=checkout["checkout_hash"],
        agent=agent,
        payee=forge_payee,
    )

    return Chain(
        l1=l1["l1"],
        l2=l2,
        l3a=l3a,
        l3b=l3b,
        checkout_jwt=checkout["checkout_jwt"],
        card_id=l1["card_id"],
        agent=agent,
    )


def _forge_l3(
    *,
    l2: str,
    card_id: str,
    checkout_jwt: str,
    checkout_hash: str,
    agent: dict[str, str],
    payee: dict[str, str],
) -> tuple[str, str]:
    """Sign L3a and L3b with the agent key, naming `payee` as the payee of record."""
    from verifiable_intent.issuance.agent import create_layer3_checkout, create_layer3_payment
    from verifiable_intent.models.agent_mandate import (
        CheckoutL3Mandate,
        FinalCheckoutMandate,
        FinalPaymentMandate,
        PaymentL3Mandate,
    )

    from vi_service import keys as key_store
    from vi_service.config import now_sec

    store = key_store.get_keystore()
    private = store.load_agent_private_key(agent["kid"], agent["enc_private_key_b64"], AGENT_ID)

    parsed = decode_sd_jwt(l2)
    checkout_disc = payment_disc = merchant_disc = item_disc = None
    for segment, values in zip(parsed.disclosures, parsed.disclosure_values, strict=True):
        value = values[-1] if values else None
        if not isinstance(value, dict):
            continue
        if value.get("vct") == "mandate.checkout.open.1" and checkout_disc is None:
            checkout_disc = segment
            continue
        if value.get("vct") == "mandate.payment.open.1" and payment_disc is None:
            payment_disc = segment
            continue
        if "id" in value and "name" in value and "website" in value and merchant_disc is None:
            merchant_disc = segment
            continue
        if "id" in value and "title" in value and item_disc is None:
            item_disc = segment
            continue
    assert payment_disc is not None and checkout_disc is not None, "the fixture L2 must be autonomous"

    base = l2.split("~")[0]
    instrument = {"type": "paypal_vault", "id": card_id, "description": "PayPal - 1234"}
    nonce = "l3-nonce-disclosure-test"
    now = now_sec()

    l3a = create_layer3_payment(
        PaymentL3Mandate(
            nonce=nonce,
            aud="https://network.countersign.test",
            iat=now,
            iss="https://agent.countersign.example",
            exp=now + 300,
            final_payment=FinalPaymentMandate(
                transaction_id=checkout_hash,
                payee=payee,
                payment_amount={"currency": CURRENCY, "amount": TOTAL_MINOR},
                payment_instrument=instrument,
            ),
            final_merchant=payee,
        ),
        private,
        base,
        payment_disc,
        merchant_disc or "",
        kid=agent["kid"],
    )
    l3b = create_layer3_checkout(
        CheckoutL3Mandate(
            nonce=nonce,
            aud=VISIBLE_MERCHANT["website"],
            iat=now,
            iss="https://agent.countersign.example",
            exp=now + 300,
            final_checkout=FinalCheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=checkout_hash),
        ),
        private,
        base,
        checkout_disc,
        item_disc or merchant_disc,
        kid=agent["kid"],
    )
    return l3a.serialize(), l3b.serialize()


def _drop_disclosure(l2: str, predicate) -> str:
    """The attack: rewrite the L2 string with matching disclosures removed.

    The JWS signature covers `header.payload` **only**, so this leaves the signed bytes untouched.
    Asserted by the callers below, because "the signature still verifies" is what makes this an
    attack on the *verifier* rather than on the signature.
    """
    parsed = decode_sd_jwt(l2)
    kept: list[str] = []
    dropped: list[str] = []
    for segment in parsed.disclosures:
        value = decode_disclosure(segment)[-1]
        if predicate(value):
            dropped.append(segment)
        else:
            kept.append(segment)
    assert dropped, "the predicate matched no disclosure, so nothing was removed"
    return "~".join([parsed.issuer_jwt, *kept]) + "~"


def _is_merchant(value: Any, merchant_id: str) -> bool:  # noqa: ANN401 - decoded disclosure, untyped by nature
    return isinstance(value, dict) and value.get("id") == merchant_id


@pytest.fixture
def two_merchant_chain(client, auth: dict[str, str], device_key) -> Chain:
    """`allowed_payees` names Beta only; Alpha is the visible shop. The QA2-VI-1 shape exactly."""
    return _build(
        client,
        auth,
        device_key,
        merchants=[VISIBLE_MERCHANT, AUTHORISED_PAYEE],
        allowed_payees=[AUTHORISED_PAYEE],
        checkout_allowed=[VISIBLE_MERCHANT],
        checkout_merchant=VISIBLE_MERCHANT,
        forge_payee=EVIL_PAYEE,
    )


@pytest.fixture
def checkout_side_chain(client, auth: dict[str, str], device_key) -> Chain:
    """The checkout-side twin: `allowed_merchants` names Beta only, the price lock names the evil shop.

    Note the *forged payee* here is Alpha (which is legitimately in `allowed_payees`), so the only
    violation available is the merchant one. A fix that only watched the payment side would still
    pass this chain, which is why it exists as a separate test.
    """
    return _build(
        client,
        auth,
        device_key,
        merchants=[VISIBLE_MERCHANT, AUTHORISED_PAYEE],
        allowed_payees=[VISIBLE_MERCHANT],
        checkout_allowed=[AUTHORISED_PAYEE],
        checkout_merchant=EVIL_PAYEE,
        forge_payee=VISIBLE_MERCHANT,
    )


# ====================================================================================================
# 1. the QA repro itself — the single most important test in this package
# ====================================================================================================


def test_EC_CONS_1_dropping_the_allowlisted_payee_disclosure_cannot_pass_verification(
    client, auth: dict[str, str], two_merchant_chain: Chain
) -> None:
    """QA2-VI-1 — the trust root must not return `chain_valid: true` for an unauthorised payee.

    Same L3a bytes. Same payee. The **only** difference between the two requests is whether one
    disclosure is present in the L2 string submitted to `/v1/verify`. That is the whole attack, and
    it lives outside the JWS signature, so the signature cannot catch it.

    Asserted, in order:
      * the control (complete L2) refuses, and names the violation — so the test would notice if the
        fixture stopped exercising the allow-list at all;
      * the narrowed L2 is byte-identical in its **signed** segment, so nothing was forged;
      * the narrowed L2 is **not** `chain_valid`, and specifically names the incomplete presentation;
      * `violations` is non-empty, so the answer is not a silent pass with a tidier shape.
    """
    baseline = client.post("/v1/verify", json=two_merchant_chain.verify_body(), headers=auth)
    assert baseline.status_code == 200
    control = baseline.json()
    assert control["chain_valid"] is False, "the control must already fail: the payee is not allowed"
    assert any("not in allowed" in v for v in control["constraints"]["violations"]), control["constraints"]

    narrowed = _drop_disclosure(two_merchant_chain.l2, lambda v: _is_merchant(v, AUTHORISED_PAYEE["id"]))

    # The attack does not touch a signed byte, and it removes exactly one disclosure.
    assert narrowed.split("~")[0] == two_merchant_chain.l2.split("~")[0]
    assert (
        len(decode_sd_jwt(narrowed).disclosures) == len(decode_sd_jwt(two_merchant_chain.l2).disclosures) - 1
    )

    attacked = client.post("/v1/verify", json=two_merchant_chain.verify_body(l2=narrowed), headers=auth)

    assert attacked.status_code == 200, "an invalid chain is a 200, never a 4xx or a 5xx"
    body = attacked.json()
    assert body["chain_valid"] is False, (
        "REFUSED: dropping one disclosure from the part of the token nobody signed turned the payee "
        "allow-list into a pass. This is QA2-VI-1."
    )
    assert body["errors"], "the refusal must name a reason"
    assert any("incomplete SD-JWT presentation" in e for e in body["errors"]), body["errors"]
    assert body["constraints"]["violations"], "an incomplete presentation must not report zero violations"
    assert body["constraints"]["satisfied"] is False
    # And it must not claim the allow-list was checked.
    assert "mandate.payment.allowed_payees" not in body["constraints"]["checked"]


# ====================================================================================================
# 2. the checkout-side twin
# ====================================================================================================


def test_EC_CONS_2_dropping_the_allowlisted_merchant_disclosure_cannot_pass_verification(
    client, auth: dict[str, str], checkout_side_chain: Chain
) -> None:
    """QA2-VI-1, checkout side — `mandate.checkout.allowed_merchants` has the identical fail-open.

    `_check_allowed_merchant` is a copy of `_check_allowed_payee`, so a fix that only guarded the
    payment side would leave the shop allow-list switchable. The price lock here is signed by the
    evil shop, which the mandate never listed.
    """
    baseline = client.post("/v1/verify", json=checkout_side_chain.verify_body(), headers=auth)
    assert baseline.status_code == 200
    control = baseline.json()
    assert control["chain_valid"] is False
    assert any("not in allowed" in v for v in control["constraints"]["violations"]), control["constraints"]

    narrowed = _drop_disclosure(checkout_side_chain.l2, lambda v: _is_merchant(v, AUTHORISED_PAYEE["id"]))
    assert narrowed.split("~")[0] == checkout_side_chain.l2.split("~")[0]

    attacked = client.post("/v1/verify", json=checkout_side_chain.verify_body(l2=narrowed), headers=auth)

    assert attacked.status_code == 200
    body = attacked.json()
    assert body["chain_valid"] is False, "REFUSED: the merchant allow-list must not be switchable either"
    assert any("incomplete SD-JWT presentation" in e for e in body["errors"]), body["errors"]
    assert body["constraints"]["violations"]
    assert "mandate.checkout.allowed_merchants" not in body["constraints"]["checked"]


# ====================================================================================================
# 3. the unauthenticated public verifier
# ====================================================================================================


def test_EC_CONS_3_the_bypass_is_closed_on_the_unauthenticated_public_verifier(
    client, two_merchant_chain: Chain
) -> None:
    """The public `/v/{packetId}` route is where a relaxed check would be *found*.

    Identical crypto to `/v1/verify` — no check is relaxed for the public route — and it is the
    route a buyer, a judge or PayPal's dispute tooling is pointed at. Sending **no** Authorization
    header is deliberate: if this test passed for any reason other than the gate, it would be a test
    of authentication rather than of completeness.
    """
    narrowed = _drop_disclosure(two_merchant_chain.l2, lambda v: _is_merchant(v, AUTHORISED_PAYEE["id"]))

    response = client.post(
        "/v1/public/verify",
        json={
            "bundle": {
                "l1": two_merchant_chain.l1,
                "l2": narrowed,
                "l3a": two_merchant_chain.l3a,
                "l3b": two_merchant_chain.l3b,
                "checkout_jwt": two_merchant_chain.checkout_jwt,
            }
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["chain_valid"] is False, "REFUSED: the public verifier must not pass an incomplete chain"
    assert any("incomplete SD-JWT presentation" in e for e in body["errors"]), body["errors"]
    assert body["constraints"]["violations"]
    assert body["constraints"]["satisfied"] is False
    # The route still answers, and still hashes the bundle it was given: a refusal is a verdict, not
    # an absence of one.
    assert isinstance(body["bundle_hash"], str) and body["bundle_hash"]


# ====================================================================================================
# 4. a legitimately complete chain is still accepted
# ====================================================================================================


def test_EC_CONS_4_a_complete_chain_with_digest_references_still_verifies(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """The fix must not break every working chain. This is the test that stops it doing that.

    Every working Countersign L2 resolves `allowed_payees` / `allowed_merchants` / `line_items` by
    **digest reference** — the constraints carry `{"...": hash}` placeholders pointing at disclosed
    merchants and items. So "require the committed disclosures to be present" must accept a chain
    that presents them all, and the digest references themselves are the interesting part: the gate
    is about *presence*, not about refusing to read references.

    Also asserts the un-hashed L1 `email` case, which is the reason the gate keys on `{"...": …}`
    placeholders rather than the `_sd` array. `create_layer1` puts the digest of the email disclosure
    in `_sd` and never inlines the address; requiring every `_sd` entry to be *presented* would
    refuse a legitimately digest-disclosed claim, which is exactly the mistake to avoid.
    """
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt as _decode

    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    assert finalized.status_code == 200, finalized.text
    l2 = finalized.json()["l2"]
    checkout = builder.checkout_jwt()
    l3 = builder.create_l3(l2, checkout, agent_key)
    assert l3.status_code == 200, l3.text

    body = client.post(
        "/v1/verify",
        json={
            "l1": l1["l1"],
            "l2": l2,
            "l3a": l3.json()["l3a"],
            "l3b": l3.json()["l3b"],
            "checkout_jwt": checkout["checkout_jwt"],
        },
        headers=auth,
    )

    assert body.status_code == 200
    result = body.json()
    assert result["chain_valid"] is True, result
    assert result["errors"] == []
    assert result["constraints"]["satisfied"] is True
    assert result["constraints"]["violations"] == []
    # The allow-lists really were enforced, so this is not passing because nothing was checked.
    assert "mandate.payment.allowed_payees" in result["constraints"]["checked"]
    assert "mandate.checkout.allowed_merchants" in result["constraints"]["checked"]

    # The digest-reference shape is genuinely present in this L2, so the assertion above is not
    # vacuous: if the library stopped emitting placeholders, this test would need rewriting.
    parsed = _decode(l2)
    payment = next(
        v[-1]
        for v in parsed.disclosure_values
        if isinstance(v[-1], dict) and v[-1].get("vct") == "mandate.payment.open.1"
    )
    refs = [
        c
        for c in payment["constraints"]
        if c["type"] == "mandate.payment.allowed_payees"
        for c in c["allowed"]
        if isinstance(c, dict) and "..." in c
    ]
    assert refs, "the fixture L2 must exercise the digest-reference path"

    # The L1's email is disclosed by digest only: `_sd` names it, the payload never inlines it.
    # A correct completeness gate accepts that, so the chain above verifies despite it.
    l1_parsed = _decode(l1["l1"])
    assert l1_parsed.payload.get("_sd"), "the L1 carries digests for its selectively disclosable claims"
    assert "email" not in l1_parsed.payload, "the email is not inlined; it is disclosed by digest"
    assert vi_l2.missing_disclosures(l1_parsed) == []


def test_EC_CONS_4b_a_withheld_l1_claim_that_is_committed_by_a_placeholder_is_still_refused(
    client, auth: dict[str, str], full_chain
) -> None:
    """The gate is about *placeholder* commitments, and it looks inside disclosures as well as the payload.

    The mandate disclosures contain the `allowed_payees` placeholders, so the gate has to walk
    **into** presented disclosures to see them — the top-level `delegate_payload` refs alone would
    all be present while the payee allow-list's own reference was withheld. This asserts that
    walking, from the unit side, so the coverage is not an accident of ordering.
    """
    parsed = decode_sd_jwt(full_chain.l2)

    # The committed set is strictly larger than the payload's own delegate_payload refs.
    payload_refs = {
        d["..."] for d in parsed.payload.get("delegate_payload", []) if isinstance(d, dict) and "..." in d
    }
    all_refs = vi_l2.committed_disclosure_refs(parsed)
    assert payload_refs < all_refs, (
        "the payee/merchant/item references live *inside* the mandate disclosures, so the gate must "
        "walk into presented disclosure values as well as the payload"
    )
    assert vi_l2.missing_disclosures(parsed) == []

    # Withhold the merchant disclosure and the gate fires on exactly that one hash.
    narrowed = _drop_disclosure(full_chain.l2, lambda v: _is_merchant(v, "mrc_northwind"))
    narrowed_parsed = decode_sd_jwt(narrowed)
    assert vi_l2.missing_disclosures(narrowed_parsed) == [
        hash_disclosure(
            next(
                s
                for s in full_chain.l2.split("~")
                if s and hash_disclosure(s) in vi_l2.committed_disclosure_refs(narrowed_parsed)
            )
        )
    ]


# ====================================================================================================
# 5. the `checked` claim
# ====================================================================================================


def test_EC_CONS_5_a_skipped_constraint_never_satisfies_an_exact_checked_includes(
    client, auth: dict[str, str]
) -> None:
    """The compounding defect: `checked` contained the constraint *and* a mangled skip annotation.

    QA2-VI-1 observed:

        checked = ['mandate.payment.allowed_payees',
                   'mandate.payment.allowed_payees (skipped: no resolved payees)', …]

    so a consumer writing the obvious `checked.includes('mandate.payment.allowed_payees')` got
    **`true`** while nothing was enforced — precisely the trap `SkippedConstraint`'s docstring says
    the type/reason split exists to remove. `classify_constraint_report` only moved entries in
    `NETWORK_ENFORCED_CONSTRAINTS`, so the mangled string stayed.

    This asserts the invariant directly: for every constraint name a caller might test,
    `checked.includes(name)` means *evaluated*, and nothing else. Asserted on the raw library output,
    on our own report, and over the wire.
    """
    from verifiable_intent.verification.constraint_checker import check_constraints

    from vi_service.models import CONSTRAINT_TYPES
    from vi_service.verify import _constraint_report

    unresolved_payees = [{"type": "mandate.payment.allowed_payees", "allowed": [{"...": "h-nope"}]}]
    fulfillment = {
        "payee": {"id": "mrc_x", "name": "X", "website": "https://x.test"},
        "payment_amount": {"currency": CURRENCY, "amount": TOTAL_MINOR},
    }

    # 0. The library really does produce the trap, so this test is not asserting a fiction.
    raw = check_constraints(unresolved_payees, fulfillment, mode="strict")
    assert "mandate.payment.allowed_payees" in raw.checked
    assert "mandate.payment.allowed_payees (skipped: no resolved payees)" in raw.checked

    # 1. Our report does not propagate it.
    report = _constraint_report(unresolved_payees, fulfillment, side="payment")
    assert report.satisfied is True  # the library's own answer; the gate is what makes this safe
    assert "mandate.payment.allowed_payees" not in report.checked
    skipped = [s for s in report.skipped if s.type == "mandate.payment.allowed_payees"]
    assert len(skipped) == 1, [s.model_dump() for s in report.skipped]
    assert "no resolved payees" in skipped[0].reason

    # 2. The invariant, stated as the caller would state it.
    for name in CONSTRAINT_TYPES:
        if name == "mandate.payment.allowed_payees":
            assert name not in report.checked
        else:
            assert name not in report.checked or name not in [s.type for s in report.skipped], (
                f"{name} is in both checked and skipped; a caller cannot tell which one happened"
            )
    assert not any("(" in entry for entry in report.checked), (
        f"checked must hold bare types only, got {report.checked}"
    )


def test_EC_CONS_5b_the_checked_skipped_disjointness_holds_over_the_wire(
    client, auth: dict[str, str], full_chain
) -> None:
    """The same invariant on a real response, so it is a wire contract and not a Python detail."""
    body = client.post("/v1/verify", json=full_chain.verify_body(), headers=auth).json()

    checked = body["constraints"]["checked"]
    skipped_types = [s["type"] for s in body["constraints"]["skipped"]]

    assert body["chain_valid"] is True
    assert checked, "a complete chain does evaluate constraints"
    for entry in checked:
        assert "(" not in entry, f"checked holds an annotated entry: {entry!r}"
        assert entry not in skipped_types, f"{entry} is reported as both checked and skipped"
    # The exact membership test a Gate would write, over the wire, on a good chain.
    assert "mandate.payment.amount_range" in checked
    assert "mandate.payment.budget" in skipped_types
    assert "mandate.payment.budget" not in checked


# ====================================================================================================
# 6. the no-crash contract
# ====================================================================================================


def test_EC_CONS_6_no_merchant_disclosure_is_a_200_with_an_honest_verdict_not_a_500(
    client, two_merchant_chain: Chain
) -> None:
    """QA2-VI-3 — `find_disclosures` used to raise `TypeError` on an L2 with no merchant disclosure.

    It passed `item or merchant` into `build_selective_presentation`, which does `"~".join(...)`;
    with no merchant the join raised, and because `verify` caught only `HTTPException` around that
    call the `TypeError` escaped to FastAPI's handler as a **500** — on the unauthenticated route,
    from well-formed JSON. That breaks this module's own contract, stated at the top of `verify.py`:

        "An invalid chain is a 200, never a 4xx … A verifier that 400s on bad evidence is a verifier
         you cannot point a judge's tool at."

    Asserted: 200, an honest refusal that names why, no traceback, and no `CS_INTERNAL`.
    """
    every_merchant_gone = _drop_disclosure(
        two_merchant_chain.l2, lambda v: isinstance(v, dict) and isinstance(v.get("website"), str)
    )
    assert len(decode_sd_jwt(every_merchant_gone).disclosures) < len(
        decode_sd_jwt(two_merchant_chain.l2).disclosures
    )

    response = client.post(
        "/v1/verify", json=two_merchant_chain.verify_body(l2=every_merchant_gone), headers=AUTH
    )

    assert response.status_code == 200, (
        f"a chain the verifier cannot slice is an invalid chain, so it is a 200: "
        f"{response.status_code} {response.text[:300]}"
    )
    text = response.text
    for leak in ("Traceback", "CS_INTERNAL", "site-packages", 'File "'):
        assert leak not in text, f"an internal detail leaked: {leak}"

    body = response.json()
    assert body["chain_valid"] is False
    assert body["errors"], "the refusal must say why"
    assert body["constraints"]["violations"]
    assert body["constraints"]["satisfied"] is False


def test_EC_CONS_6b_the_single_merchant_no_merchant_disclosure_case_is_also_a_200(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """QA2-VI-3's A5 variant: one merchant in the mandate, and its only disclosure withheld.

    A separate case because the shape differs — with a single merchant there is no second candidate
    for `find_disclosures` to fall through to, which is exactly the case that used to 500.
    """
    chain = _build(
        client,
        auth,
        device_key,
        merchants=[VISIBLE_MERCHANT],
        allowed_payees=[VISIBLE_MERCHANT],
        checkout_allowed=[VISIBLE_MERCHANT],
        checkout_merchant=VISIBLE_MERCHANT,
        forge_payee=EVIL_PAYEE,
    )
    narrowed = _drop_disclosure(chain.l2, lambda v: _is_merchant(v, VISIBLE_MERCHANT["id"]))

    response = client.post("/v1/verify", json=chain.verify_body(l2=narrowed), headers=auth)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["chain_valid"] is False
    assert body["errors"]
    assert "CS_INTERNAL" not in response.text


# ====================================================================================================
# 7. the rate-limit trust boundary
# ====================================================================================================


def _reset() -> None:
    config.reset_settings()
    keys.reset_keystore()
    vi_l2.reset_prepare_store()
    ratelimit.reset_limiter()


def test_EC_RL_1_thirty_one_requests_from_one_client_the_thirty_first_is_refused(client, monkeypatch) -> None:
    """§8.3 — 30/min/IP, and the *client* is the socket address by default.

    All 31 requests come from the same genuine client (the TestClient's socket), so this is the
    budget working as specified rather than a proxy-hop question.
    """
    monkeypatch.setenv("VI_TRUSTED_PROXY_HOPS", "0")
    _reset()

    statuses = [client.get("/v1/jwks").status_code for _ in range(30)]
    assert statuses == [200] * 30, "the first 30 requests are inside budget"

    refused = client.get("/v1/jwks")
    assert refused.status_code == 429, f"the 31st must be refused, got {refused.status_code}"
    error = refused.json()["error"]
    assert error["code"] == "CS_RATE_LIMITED"
    assert error["retryable"] is True
    assert refused.headers["Retry-After"]


def test_EC_RL_2_a_varying_forwarded_for_header_does_not_reset_the_budget(client, monkeypatch) -> None:
    """QA2-VI-4 — 35 requests with 35 different first hops used to all return 200.

    `client_id_for` preferred `X-Forwarded-For` over `request.client.host` unconditionally, taking
    hop 1 verbatim. Hop 1 is the real client only if a proxy we control *wrote* it; since the header
    is an ordinary unauthenticated request header, a caller who controls it controls which budget
    they are billed to, so §8.3's limit became per-callable-string.

    The default is now `VI_TRUSTED_PROXY_HOPS=0`: the header is ignored and the socket address is the
    only client identity. Rotating it must not buy budget.
    """
    monkeypatch.setenv("VI_TRUSTED_PROXY_HOPS", "0")
    _reset()

    for i in range(30):
        response = client.get("/v1/jwks", headers={"X-Forwarded-For": f"10.0.0.{i}"})
        assert response.status_code == 200, f"request {i} unexpectedly {response.status_code}"

    rotated = client.get("/v1/jwks", headers={"X-Forwarded-For": "10.0.0.99"})
    assert rotated.status_code == 429, (
        "rotating X-Forwarded-For must not reset the budget; the header is caller-controlled"
    )

    # And the unit-level rule, stated directly so the intent is unambiguous.
    from vi_service.ratelimit import client_id_for

    assert client_id_for("203.0.113.9", "1.2.3.4", trusted_hops=0) == "203.0.113.9"
    assert client_id_for("203.0.113.9", None, trusted_hops=0) == "203.0.113.9"


def test_EC_RL_3_trusting_one_proxy_hop_bills_the_client_not_the_callers_string(client, monkeypatch) -> None:
    """`trusted_hops=N` asserts "the last N hops were written by proxies I control".

    Stated as its own test because this is the configuration an operator actually turns on behind an
    edge, and it is where an off-by-one would quietly reintroduce QA2-VI-4 in the other direction —
    billing the proxy's own address for every caller, i.e. a 30/min budget for the whole world.
    """
    from vi_service.ratelimit import client_id_for

    # One trusted proxy: `client, proxy_ours` -> ours is the last entry, so the client is the one
    # before it. The spoofable leading value is never the answer.
    assert client_id_for("10.0.0.1", "1.2.3.4, 10.0.0.1", trusted_hops=1) == "1.2.3.4"
    assert client_id_for("10.0.0.1", "9.9.9.9, 1.2.3.4, 10.0.0.1", trusted_hops=1) == "1.2.3.4"

    # Two trusted proxies: `ours_a, ours_b` are the rightmost two, so the client is the third from
    # the end. Raising the count moves the answer *away* from hop 1, which is the point.
    assert client_id_for("10.0.0.1", "9.9.9.9, 1.2.3.4, 5.6.7.8", trusted_hops=2) == "9.9.9.9"
    assert client_id_for("10.0.0.1", "9.9.9.9, 1.2.3.4, 5.6.7.8", trusted_hops=1) == "1.2.3.4"

    # Fewer entries than trusted proxies: the header carries nothing attributable to the client, so
    # the socket address is used. An availability cost, chosen over a spoofable identity — and the
    # honest configuration for a *replacing* proxy, whose output is indistinguishable from a
    # caller's own header.
    assert client_id_for("10.0.0.1", "1.2.3.4", trusted_hops=1) == "10.0.0.1"
    assert client_id_for("10.0.0.1", "1.2.3.4, 10.0.0.1", trusted_hops=3) == "10.0.0.1"

    # Empty hops are skipped rather than trusted, so they cannot shift the index.
    assert client_id_for("10.0.0.1", ",1.2.3.4, 10.0.0.1", trusted_hops=1) == "1.2.3.4"

    assert client_id_for(None, None, trusted_hops=0) == "unknown"
    assert client_id_for(None, "1.2.3.4", trusted_hops=0) == "unknown"


def test_EC_RL_4_the_trusted_proxy_setting_is_configurable_with_a_safe_default(client, monkeypatch) -> None:
    """Zero is the default, and a malformed value refuses to boot rather than silently trusting.

    A trust setting that defaults to anything else is a vulnerability waiting for a deployment
    topology, so the default is asserted explicitly rather than left implicit.
    """
    from vi_service.config import ConfigError, get_settings

    monkeypatch.delenv("VI_TRUSTED_PROXY_HOPS", raising=False)
    _reset()
    assert get_settings().trusted_proxy_hops == 0, "the safe default is to trust no hop"

    monkeypatch.setenv("VI_TRUSTED_PROXY_HOPS", "1")
    _reset()
    assert get_settings().trusted_proxy_hops == 1

    monkeypatch.setenv("VI_TRUSTED_PROXY_HOPS", "not-a-number")
    _reset()
    with pytest.raises(ConfigError):
        get_settings()

    _reset()


# ====================================================================================================
# 8. `l3/create` refuses to sign against an incomplete L2
# ====================================================================================================


def test_EC_CONS_7_l3_create_refuses_an_l2_missing_a_committed_disclosure(
    client, auth: dict[str, str], builder, device_key, agent_key
) -> None:
    """The same hole existed on the signing route, and closing it there matters independently.

    `l3/create` is the last point before a purchasing authority exists. If it accepts an L2 whose
    payee allow-list cannot be resolved, the pinned library's skip-and-pass would make its
    pre-check evaluate *nothing* about the payee and it would sign an L3a for anyone — turning the
    "refuse to sign out-of-mandate" property into a formality.
    """
    from conftest import MERCHANT

    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    finalized = builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"]))
    l2 = finalized.json()["l2"]
    checkout = builder.checkout_jwt()

    narrowed = _drop_disclosure(l2, lambda v: _is_merchant(v, MERCHANT["id"]))

    response = builder.create_l3(narrowed, checkout, agent_key)

    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] in {"VI_CHAIN_INVALID", "VI_CONSTRAINT_VIOLATION"}
    assert "incomplete SD-JWT presentation" in error["message"]
    assert "l3a" not in response.json()


def test_EC_CONS_8_an_unresolved_reference_raises_rather_than_resolving_to_itself(
    client, auth: dict[str, str], full_chain
) -> None:
    """Requirement 3 — `resolve_disclosure_refs` must not fall back to returning the reference.

    The old line was `return by_hash.get(entry["..."], entry)`, so a missing disclosure left
    `{"...": "<hash>"}` in the constraint and the library read that as "skipped, no resolved
    payees" with `satisfied` untouched. A reference that resolves to itself is a silent pass waiting
    to happen again, so it now raises.

    Asserted as an exception rather than through a route, because the point is that the helper
    itself refuses — a route-level test would pass even if the helper regressed and some other check
    happened to catch the chain.
    """
    parsed = decode_sd_jwt(full_chain.l2)
    constraints = [{"type": "mandate.payment.allowed_payees", "allowed": [{"...": "h-not-present"}]}]

    with pytest.raises(vi_l2.UnresolvedDisclosureRef) as excinfo:
        vi_l2.resolve_disclosure_refs(parsed, constraints)
    assert "h-not-present" in excinfo.value.refs

    # And the complete case still resolves, so the refusal is not unconditional.
    payment = next(
        v[-1]
        for v in parsed.disclosure_values
        if isinstance(v[-1], dict) and v[-1].get("vct") == "mandate.payment.open.1"
    )
    resolved = vi_l2.resolve_disclosure_refs(parsed, payment["constraints"])
    payees = next(c for c in resolved if c["type"] == "mandate.payment.allowed_payees")
    assert payees["allowed"] and "..." not in payees["allowed"][0], payees


def test_EC_CONS_9_the_refusal_names_the_missing_disclosure_without_leaking_it_whole(
    client, auth: dict[str, str], full_chain
) -> None:
    """The reason string is quotable in an evidence packet and does not echo token material.

    A 43-character hash prefix identifies which commitment was unmet, which is what makes the
    refusal diagnosable, and it is not a secret: it is already in the token the caller sent us.
    """
    narrowed = _drop_disclosure(full_chain.l2, lambda v: _is_merchant(v, "mrc_northwind"))
    response = client.post("/v1/verify", json=full_chain.verify_body(l2=narrowed), headers=auth)

    assert response.status_code == 200
    body = response.json()
    reasons = [e for e in body["errors"] if "incomplete SD-JWT presentation" in e]
    assert reasons, body["errors"]
    assert ".." in reasons[0], "the missing digest is reported in truncated form"
    assert len(reasons[0]) < 900, "the reason is a sentence, not a dump"
    for leak in ("Traceback", "enc_private", "VI_KEK", "eyJ"):
        assert leak not in response.text


def test_EC_CONS_10_the_disclosure_set_is_reported_verbatim_so_a_packet_is_reproducible(
    client, auth: dict[str, str], full_chain
) -> None:
    """`disclosed.l2` is still resolved from the presentation, so a narrowing is visible on the wire.

    Not a completeness check itself — the gate is — but the resolved claim set is what an evidence
    packet quotes, so it must not silently present a partial mandate as a complete one.
    """
    from verifiable_intent.crypto.sd_jwt import decode_sd_jwt as _decode
    from verifiable_intent.crypto.sd_jwt import resolve_disclosures

    parsed = _decode(full_chain.l2)
    disclosed = resolve_disclosures(parsed)
    assert any(
        isinstance(d, dict) and d.get("vct") == "mandate.payment.open.1"
        for d in disclosed.get("delegate_payload", [])
    )

    narrowed = decode_sd_jwt(_drop_disclosure(full_chain.l2, lambda v: _is_merchant(v, "mrc_northwind")))
    narrowed_claims = resolve_disclosures(narrowed)
    # The mandate is still there — it is the *referenced* merchant that is gone, which is why a
    # verdict that only looked at the mandate would have looked complete.
    assert any(
        isinstance(d, dict) and d.get("vct") == "mandate.payment.open.1"
        for d in narrowed_claims.get("delegate_payload", [])
    )
    assert vi_l2.missing_disclosures(narrowed)
