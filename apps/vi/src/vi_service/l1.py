"""Layer 1: the issuer credential (spec §8.3 `POST /v1/l1/issue`).

The issuer signs a credential that binds three things and nothing else:

* **who** the user is (``sub``),
* **which device key** may sign on their behalf (``cnf.jwk`` — the RFC 7800 confirmation method),
* **which instrument** may be charged (``card_id``, cross-checked against the L2's
  ``payment_instrument.id`` by `verify_chain`).

L1 is the root of trust for a purchase. Everything downstream is a delegation from the key this
token binds, so this function is deliberately thin: it signs, and it validates its own inputs
before signing. It never decides whether the user should get an L1 — that is `apps/web`'s job
after PayPal confirms the vault.

EC-TIME-1 is the reason `iat`/`exp` come from `config.now_sec()` and never from the request: a
browser whose clock is wrong by hours cannot influence either value, because it does not supply
them.
"""

from __future__ import annotations

import hashlib

from verifiable_intent.issuance.issuer import create_layer1
from verifiable_intent.models.issuer_credential import IssuerCredential

from . import errors
from .config import Settings, get_settings, now_sec
from .keys import get_keystore, rfc7638_thumbprint
from .models import L1IssueRequest, L1IssueResponse

#: The library's default `expected_l1_vct`. `verify_chain` pins this exact string, so changing it
#: here would make every chain unverifiable. Spec D2/B1: the chain format is not ours to change.
L1_VCT = "https://credentials.mastercard.com/card"


def card_id_for(payment_token_id: str) -> str:
    """`card_id` = lowercase hex SHA-256 of the PayPal vault payment-token id.

    Two rules make this safe to cross-check, and both matter:

    * it is a *hash*, so the vault id never appears in an evidence packet in the clear;
    * it is deterministic, so `apps/web` can compute the identical value for
      `payment_instrument.id` when it builds the L2 and the Gate can compare the two sides.

    `verify_chain` reads `card_id` as a SHOULD-level cross-check and **fails closed** when the
    two disagree (or when `card_id` is set but `payment_instrument.id` is absent). So the L1 route
    and the L2 route must agree, and both use this function.
    """
    return hashlib.sha256(payment_token_id.encode("utf-8")).hexdigest()


def issue_l1(req: L1IssueRequest, settings: Settings | None = None) -> L1IssueResponse:
    """Mint an L1 with the issuer key named by ``VI_ISSUER_KID``."""
    settings = settings or get_settings()
    store = get_keystore()

    issued_at = now_sec()
    expires_at = issued_at + req.ttl_days * 86_400
    device_jwk = req.device_public_jwk.as_dict()
    card_id = card_id_for(req.wallet.payment_token_id)

    credential = IssuerCredential(
        iss=settings.issuer_url,
        # `sub` is the user id. The PayPal payer id and email are *not* always-visible claims:
        # email goes in as the single selectively-disclosable claim so a verifier can ask for it
        # without a fresh issuance.
        sub=req.user_id,
        iat=issued_at,
        exp=expires_at,
        vct=L1_VCT,
        # `aud` is left unset. `verify_chain` never checks it, and putting an app-mode string in an
        # `aud` claim would be a lie about who the credential is for.
        cnf_jwk=device_jwk,
        pan_last_four=req.pan_last_four,
        scheme=req.scheme,
        card_id=card_id,
        email=req.wallet.payer_email,
    )

    try:
        sd_jwt = create_layer1(credential, store.signing_key("ISSUER"), kid=store.current_kid("ISSUER"))
    except Exception as exc:  # noqa: BLE001 - a signing failure must never cross as a raw error
        raise errors.http_error(
            "CS_VALIDATION", f"Could not issue the L1 credential: {type(exc).__name__}: {exc}"
        ) from exc

    return L1IssueResponse(
        l1=sd_jwt.serialize(),
        iat=issued_at,
        exp=expires_at,
        issuer_kid=sd_jwt.header.get("kid", store.current_kid("ISSUER")),
        card_id=card_id,
        device_jkt=rfc7638_thumbprint(device_jwk),
    )
