"""Layer 3: the agent's fulfilment, split into L3a (payment) and L3b (checkout).

Spec §8.3: `POST /v1/l3/create` returns `{l3a, l3b, jti}` and its one documented error is
`VI_CONSTRAINT_VIOLATION` — "pre-check: refuse to sign out-of-mandate".

That pre-check is the whole reason this route is not a signing oracle with a validator in front of
it. The agent is the *untrusted* party in this system (spec §3.1: the agent chat is an untrusted
input surface, the LLM's output is never authority). If `l3/create` would sign anything, a prompt
injection in a product listing would end with a validly signed authorisation. So this module runs
the same STRICT-mode constraint check the Gate will run, against the same resolved SD references,
**before** the agent key touches anything — and on failure the answer is a refusal, not a warning.

`jti` is derived, not random
----------------------------
The library's L3 payload has no ``jti`` claim, but ``checkout_attempts.l3_jti`` is unique in the
data model and is what gives replay protection (spec §7.2, §12.2). So ``jti`` is
base64url(SHA-256(L3a issuer JWT)): deterministic, so a retried request yields the same jti and the
Gate's unique constraint does the deduplication; and content-bound, so two different
authorisations can never collide on it.
"""

from __future__ import annotations

import hashlib
from typing import Any

from verifiable_intent.crypto.sd_jwt import SdJwt
from verifiable_intent.issuance.agent import create_layer3_checkout, create_layer3_payment
from verifiable_intent.models.agent_mandate import (
    CheckoutL3Mandate,
    FinalCheckoutMandate,
    FinalPaymentMandate,
    PaymentL3Mandate,
)
from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints

from . import errors
from .checkout_jwt import (
    checkout_hash_from_jwt,
    decode_checkout_jwt_payload,
    verify_checkout_signature,
)
from .config import Settings, get_settings, now_sec
from .keys import b64u_encode, get_keystore
from .l2 import decode_l2, find_disclosures, resolve_disclosure_refs
from .models import L3CreateRequest, L3CreateResponse

#: The open (autonomous) mandate VCTs. Both must be present for a split L3 to be buildable.
_CHECKOUT_OPEN_VCT = "mandate.checkout.open.1"
_PAYMENT_OPEN_VCT = "mandate.payment.open.1"


def _mandate(claims: dict[str, Any], vct: str) -> dict[str, Any]:
    """The first resolved delegate with `vct`."""
    for delegate in claims.get("delegate_payload", []) or []:
        if isinstance(delegate, dict) and delegate.get("vct") == vct:
            return delegate
    raise errors.http_error(
        "VI_CHAIN_INVALID",
        f"The L2 carries no {vct} disclosure. An autonomous L2 must contain both open mandates.",
    )


def _merchant_from_l2(l2: SdJwt, payee_id: str) -> dict[str, Any]:
    """The L2's own merchant disclosure for `payee_id`.

    Read from the L2, never from the request: the L3a's `payee` has to be a merchant the *user*
    approved, and the L2's merchant disclosures are the signed record of that.

    Note where merchants actually live. `resolve_disclosures` resolves the *named object* claims and
    the `delegate_payload` references; the standalone merchant and acceptable-item disclosures are
    referenced only from inside a constraint, so they stay in `l2.disclosures` and never appear in
    the resolved claim set. Looking for the payee in `delegate_payload` therefore finds nothing and
    would refuse every legitimate purchase.
    """
    for disc_value in l2.disclosure_values:
        value = disc_value[-1] if disc_value else None
        if (
            isinstance(value, dict)
            and value.get("id") == payee_id
            and value.get("name")
            and value.get("website")
        ):
            return value
    raise errors.http_error(
        "VI_CONSTRAINT_VIOLATION",
        f"payee_id={payee_id!r} does not match any merchant in this L2. The L2's merchant entries are "
        "the signed allowlist, so a payee outside it cannot be signed.",
        {"payee_id": payee_id},
    )


def create_l3(req: L3CreateRequest, settings: Settings | None = None) -> L3CreateResponse:
    """Pre-check against the L2's own constraints, then sign L3a and L3b."""
    settings = settings or get_settings()
    store = get_keystore()

    # A caller that has no key registered under the `kid` it named is out of contract, and saying so
    # first costs one dict lookup. Checked before any parsing or decryption, so a bad `kid` cannot
    # make us do work on its behalf.
    store.require_agent_entry(req.agent_kid)

    l2 = decode_l2(req.l2)
    l2_claims = _resolve_disclosures(l2)
    payment_mandate = _mandate(l2_claims, _PAYMENT_OPEN_VCT)
    checkout_mandate = _mandate(l2_claims, _CHECKOUT_OPEN_VCT)

    # --- the price lock must be ours and unexpired before we hang a mandate off it ---
    signature_ok, signature_error = verify_checkout_signature(req.checkout_jwt, settings)
    if not signature_ok:
        raise errors.http_error(
            "VI_CHAIN_INVALID",
            f"The checkout JWT does not verify against a merchant key we know: {signature_error}",
        )
    cart = decode_checkout_jwt_payload(req.checkout_jwt)
    cart_exp = cart.get("exp")
    issued_at = now_sec()
    if isinstance(cart_exp, int) and issued_at > cart_exp:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"The price lock expired at {cart_exp}; the agent must re-quote before we sign an L3.",
            {"price_lock_exp": cart_exp, "now": issued_at},
        )
    checkout_hash = checkout_hash_from_jwt(req.checkout_jwt)

    payee = _merchant_from_l2(l2, req.payment.payee_id)

    # --- pre-check: the same STRICT evaluation the Gate will do, before signing anything ------
    payment_constraints = [
        c
        for c in resolve_disclosure_refs(l2, payment_mandate.get("constraints") or [])
        if isinstance(c, dict)
    ]
    payment_fulfilment: dict[str, Any] = {
        "transaction_id": checkout_hash,
        "payee": payee,
        "payment_amount": {"currency": req.payment.currency, "amount": req.payment.amount_minor},
        "payment_instrument": payment_mandate.get("payment_instrument"),
    }
    payment_report = check_constraints(payment_constraints, payment_fulfilment, mode=StrictnessMode.STRICT)
    if not payment_report.satisfied:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            "Refusing to sign L3a: the requested payment is outside the limits the user signed.",
            {
                "side": "payment",
                "violations": payment_report.violations,
                "amount_minor": req.payment.amount_minor,
                "currency": req.payment.currency,
                "payee_id": req.payment.payee_id,
            },
        )

    cart_items = (cart.get("cart") or {}).get("items") or []
    checkout_constraints = [
        c
        for c in resolve_disclosure_refs(l2, checkout_mandate.get("constraints") or [])
        if isinstance(c, dict)
    ]
    checkout_fulfilment: dict[str, Any] = {
        "merchant": (cart.get("cart") or {}).get("merchant") or cart.get("merchant"),
        "line_items": [{"id": item.get("sku"), "quantity": item.get("quantity")} for item in cart_items],
    }
    checkout_report = check_constraints(checkout_constraints, checkout_fulfilment, mode=StrictnessMode.STRICT)
    if not checkout_report.satisfied:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            "Refusing to sign L3b: this cart is outside the items and merchants the user signed.",
            {"side": "checkout", "violations": checkout_report.violations},
        )

    # --- sign --------------------------------------------------------------------------------
    # The private key exists here only as ciphertext plus a KEK. It is decrypted for the length of
    # this call and never logged, returned or stored in plaintext.
    agent_key = store.load_agent_private_key(req.agent_kid, req.enc_private_key_b64, req.agent_id)

    cart_skus = [item.get("sku") for item in cart_items if isinstance(item, dict)]
    disclosures = find_disclosures(
        l2, merchant_id=req.payment.payee_id, item_id=cart_skus[0] if cart_skus else None
    )

    # The library hard-codes "exactly two disclosures" per selective presentation, so the second
    # element must always be a real L2 disclosure. An acceptable item is the right one for the
    # merchant's view; if the mandate carried no items at all, the merchant disclosure is the
    # closest thing that is actually inside the signed set.
    checkout_second = disclosures.item or disclosures.merchant
    if checkout_second is None:  # pragma: no cover - an autonomous L2 always has a merchant entry
        raise errors.http_error(
            "VI_CHAIN_INVALID",
            "The L2 contains neither an acceptable-item nor a merchant disclosure, so no selective "
            "presentation can be built for the merchant.",
        )

    expires_at = issued_at + req.ttl_seconds

    l3a = create_layer3_payment(
        PaymentL3Mandate(
            nonce=req.nonce,
            aud=req.aud,
            iat=issued_at,
            iss=req.iss or settings.agent_iss,
            exp=expires_at,
            final_payment=FinalPaymentMandate(
                transaction_id=checkout_hash,
                payee=payee,
                payment_amount={
                    "currency": req.payment.currency,
                    "amount": req.payment.amount_minor,
                },
                # Taken from the L2, never from the request: `verify_chain` cross-checks the L3
                # instrument against the L2's authorised one and fails closed on a mismatch, so
                # this is the value that keeps the two tied together.
                payment_instrument=payment_mandate.get("payment_instrument") or {},
            ),
            final_merchant=payee,
        ),
        agent_key,
        disclosures.base_jwt,
        disclosures.payment_mandate,
        disclosures.merchant or "",
        kid=req.agent_kid,
    )

    l3b = create_layer3_checkout(
        CheckoutL3Mandate(
            nonce=req.nonce,
            # L3b's audience is the merchant that will ship. Derived from the price lock we just
            # verified, so `verify(expected_l3_checkout_aud=…)` can pin it to the shop the user
            # actually authorised, not to a value the caller chose.
            aud=_merchant_aud(cart),
            iat=issued_at,
            iss=req.iss or settings.agent_iss,
            exp=expires_at,
            final_checkout=FinalCheckoutMandate(checkout_jwt=req.checkout_jwt, checkout_hash=checkout_hash),
        ),
        agent_key,
        disclosures.base_jwt,
        disclosures.checkout_mandate,
        checkout_second,
        kid=req.agent_kid,
    )

    l3a_serialized = l3a.serialize()
    return L3CreateResponse(
        l3a=l3a_serialized,
        l3b=l3b.serialize(),
        jti=b64u_encode(hashlib.sha256(l3a.issuer_jwt.encode("ascii")).digest()),
        iat=issued_at,
        exp=expires_at,
        checkout_hash=checkout_hash,
        payment_presentation=disclosures.payment_presentation,
        checkout_presentation=disclosures.checkout_presentation,
    )


def _resolve_disclosures(l2: SdJwt) -> dict[str, Any]:
    """Resolve every SD disclosure in an L2 into a plain claim set."""
    from verifiable_intent.crypto.sd_jwt import resolve_disclosures

    return resolve_disclosures(l2)


def _merchant_aud(cart: dict[str, Any]) -> str:
    """The merchant URL that L3b is addressed to."""
    merchant = (cart.get("cart") or {}).get("merchant") or cart.get("merchant") or {}
    website = merchant.get("website") if isinstance(merchant, dict) else None
    if isinstance(website, str) and website:
        return website
    iss = cart.get("iss")
    if isinstance(iss, str) and iss:
        return iss
    raise errors.http_error(
        "VI_CHAIN_INVALID",
        "The checkout JWT names no merchant URL, so L3b would have no audience.",
    )
