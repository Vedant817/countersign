"""The merchant-signed, price-locked checkout JWT (spec §8.3, EC-FX-6).

Ported from ``examples/helpers.py::create_checkout_jwt`` and ``checkout_hash_from_jwt`` at the
pinned commit, with exactly **one** change, which is the point of this module:

> **Amounts are integer minor units plus a currency field. Never float dollars.**

The reference helper writes ``"unitPrice": unit_price_cents / 100`` and ``"subTotal": {"amount":
total_cents / 100}``. That is a float, and a float is a rounding bug waiting for a price that
does not divide by 100 (spec §0, §8.0 rule 9). We carry ``unit_minor``/``amount_minor`` as
integers and render at the edge, in `apps/web`.

Everything else is faithful, because it has to be:

* the payload shape the library and the Gate expect;
* ``iss`` = our merchant URL (the reference hard-codes the demo shop);
* ``checkout_hash`` = base64url SHA-256 over the **ASCII** JWT bytes.

That last one is the byte-for-byte requirement. ``issuance/user.py`` recomputes it as
``sha256(checkout_jwt.encode("ascii"))`` and ``verification/integrity.py`` verifies it the same
way. The reference helper uses ``.encode("utf-8")``, which is identical for ASCII input — a JWS is
base64url plus dots, so it is always ASCII — and we hash ASCII explicitly so the invariant is
checked instead of assumed: a non-ASCII byte here would raise rather than produce a hash that
silently disagrees with the library's.
"""

from __future__ import annotations

import hashlib
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec
from verifiable_intent.crypto.signing import _jwt_encode

from . import errors
from .config import Settings, get_settings, now_sec
from .keys import b64u_encode, get_keystore
from .models import CheckoutJwtRequest, CheckoutJwtResponse

#: The reference header. `typ: JWT` (not `sd+jwt`) — this is a plain signed JWT, not an SD-JWT.
_HEADER_TYP = "JWT"
#: `sub` the reference uses for a cart checkout. Kept so the shape stays recognisable.
_CART_SUBJECT = "cart_checkout"


def checkout_hash_from_jwt(checkout_jwt: str) -> str:
    """base64url SHA-256 of the checkout JWT's ASCII bytes.

    Must agree byte-for-byte with what `issuance/user.py` computes and `verification/integrity.py`
    verifies, or the L2 and L3 bindings break with a mismatch nobody can explain. Both of those use
    ``.encode("ascii")``; so do we.
    """
    try:
        raw = checkout_jwt.encode("ascii")
    except UnicodeEncodeError as exc:
        raise errors.http_error(
            "CS_VALIDATION",
            "The checkout JWT must be ASCII (base64url segments and dots only) so its hash agrees "
            "with the one issuance/user.py recomputes.",
        ) from exc
    return b64u_encode(hashlib.sha256(raw).digest())


def decode_checkout_jwt_payload(checkout_jwt: str) -> dict[str, Any]:
    """The checkout JWT's decoded payload, for `l3/create`'s pre-check and `verify`'s tamper test."""
    import base64
    import json

    parts = checkout_jwt.split(".")
    if len(parts) != 3:
        raise errors.http_error(
            "CS_VALIDATION", f"A checkout JWT has 3 dot-separated segments, got {len(parts)}"
        )
    try:
        padding = -len(parts[1]) % 4
        return json.loads(base64.urlsafe_b64decode(parts[1] + "=" * padding))
    except Exception as exc:  # noqa: BLE001
        raise errors.http_error("CS_VALIDATION", f"checkout_jwt payload is not decodable: {exc}") from exc


def decode_checkout_jwt_header(checkout_jwt: str) -> dict[str, Any]:
    import base64
    import json

    parts = checkout_jwt.split(".")
    try:
        padding = -len(parts[0]) % 4
        return json.loads(base64.urlsafe_b64decode(parts[0] + "=" * padding))
    except Exception as exc:  # noqa: BLE001
        raise errors.http_error("CS_VALIDATION", f"checkout_jwt header is not decodable: {exc}") from exc


def verify_checkout_signature(checkout_jwt: str, settings: Settings | None = None) -> tuple[bool, str | None]:
    """Verify the checkout JWT against whichever merchant key its own ``kid`` names.

    Retired merchant keys keep verifying (spec EC-KEY-3): a price lock issued before a rotation is
    still a valid price lock, and a dispute filed after the rotation must still check out.
    """
    from .keys import get_keystore as _keystore

    settings = settings or get_settings()
    header = decode_checkout_jwt_header(checkout_jwt)
    if header.get("alg") != "ES256":
        return False, f"checkout JWT alg must be ES256, got {header.get('alg')!r}"
    if header.get("typ") != _HEADER_TYP:
        return False, f"checkout JWT typ must be {_HEADER_TYP!r}, got {header.get('typ')!r}"
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        return False, "checkout JWT header has no kid, so no merchant key can be resolved"

    store = _keystore()
    entry = store.get(kid)
    if entry is None:
        return False, f"unknown merchant key id: {kid}"
    if entry.role != "MERCHANT":
        return False, f"key {kid} is a {entry.role} key, not a MERCHANT key"
    if entry.status == "COMPROMISED":
        return False, f"merchant key {kid} is marked COMPROMISED and no longer verifies"

    pub = store.public_key_by_kid(kid)
    if pub is None:  # pragma: no cover - unreachable given the checks above
        return False, f"merchant key {kid} has no usable public half"

    import base64

    signing_input, sig_b64 = checkout_jwt.rsplit(".", 1)
    padding = -len(sig_b64) % 4
    try:
        signature = base64.urlsafe_b64decode(sig_b64 + "=" * padding)
    except Exception as exc:  # noqa: BLE001
        return False, f"checkout JWT signature is not base64url: {exc}"

    from verifiable_intent.crypto.signing import es256_verify

    try:
        ok = es256_verify(signing_input.encode("ascii"), signature, pub)
    except Exception:  # noqa: BLE001 - a crafted signature is a failure, never a 500
        ok = False
    return ok, None if ok else "checkout JWT signature does not verify against its kid"


def create_checkout_jwt(req: CheckoutJwtRequest, settings: Settings | None = None) -> CheckoutJwtResponse:
    """Sign the price lock with the merchant key named by ``VI_MERCHANT_KID``."""
    settings = settings or get_settings()
    store = get_keystore()
    merchant_key: ec.EllipticCurvePrivateKey = store.signing_key("MERCHANT")
    kid = store.current_kid("MERCHANT")

    issued_at = now_sec()
    expires_at = issued_at + req.ttl_seconds

    items: list[dict[str, Any]] = []
    subtotal_minor = 0
    for line in req.lines:
        # Integers throughout. `qty * unit_minor` is exact in Python; in a float it would not be
        # for most prices, which is the whole of EC-FX-6.
        line_minor = line.qty * line.unit_minor
        subtotal_minor += line_minor
        items.append(
            {
                "sku": line.sku,
                "title": line.title,
                "quantity": line.qty,
                "unit_minor": line.unit_minor,
                "line_minor": line_minor,
            }
        )

    total_minor = subtotal_minor + req.shipping_minor + req.tax_minor
    money = {"amount_minor": total_minor, "currency_code": req.currency}
    merchant = req.merchant.model_dump()

    payload: dict[str, Any] = {
        # Our merchant URL, not the demo shop's. Spec §8.3 names this as the one required change
        # to the reference helper alongside the integer amounts.
        "iss": req.merchant.website,
        "sub": _CART_SUBJECT,
        "iat": issued_at,
        "exp": expires_at,
        "merchant": merchant,
        "cart": {
            "merchant": merchant,
            "items": items,
            "subtotal": {"amount_minor": subtotal_minor, "currency_code": req.currency},
            "shipping": {"amount_minor": req.shipping_minor, "currency_code": req.currency},
            "tax": {"amount_minor": req.tax_minor, "currency_code": req.currency},
            "total": money,
        },
    }
    if req.checkout_id:
        payload["checkout_id"] = req.checkout_id

    header = {"alg": "ES256", "typ": _HEADER_TYP, "kid": kid}
    checkout_jwt = _jwt_encode(header, payload, merchant_key)

    return CheckoutJwtResponse(
        checkout_jwt=checkout_jwt,
        checkout_hash=checkout_hash_from_jwt(checkout_jwt),
        exp=expires_at,
        total_minor=total_minor,
        currency=req.currency,
        kid=kid,
    )
