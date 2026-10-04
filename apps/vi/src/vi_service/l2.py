"""Layer 2: the user mandate, built in two phases (spec D3, §8.3, §11 check C3(a)).

Why two phases at all
---------------------
The user's device key is generated in the browser as **non-extractable**
(`crypto.subtle.generateKey(..., false, …)`, spec §3.1 and §8.5). vi-service never sees it, so it
cannot sign an L2 itself. It builds the body; the browser signs the exact bytes.

Why that is safe rather than a way to attach an arbitrary signature
-------------------------------------------------------------------
Because `finalize` **verifies the signature against the device key bound in the L1's `cnf.jwk`
before it returns anything**. A caller who substitutes someone else's signature gets
`VI_SIGNATURE_MISMATCH` and no L2. Without that check, "the service builds the body" would mean
"anyone can attach any signature to any mandate", which would defeat the entire chain: the L2 is
the consent, and consent that anyone can manufacture is not consent.

So the two phases are not a convenience split. `prepare` is trusted only because `finalize` binds
the result to a key the caller cannot choose.

The signing input
-----------------
``create_layer2_autonomous`` is called with a **throwaway ephemeral key**. The library signs the
JWT and we then throw the signature away, keeping only ``header.payload``. The browser signs the
ASCII bytes of that same string, and `finalize` splices the result back on. The bytes are
byte-identical because both sides work from the same two base64url segments: ES256 signs
``ASCII(JWS Signing Input)`` (RFC 7515 §5.1) and `verify_sd_jwt_signature` recomputes it by
re-encoding `header`/`payload` as compact JSON — which round-trips exactly, because the segments
are stored raw and never re-serialised.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from verifiable_intent.crypto.disclosure import build_selective_presentation, hash_bytes
from verifiable_intent.crypto.sd_jwt import SdJwt, decode_sd_jwt
from verifiable_intent.crypto.signing import es256_verify, generate_es256_key, jwk_to_public_key
from verifiable_intent.issuance.user import create_layer2_autonomous
from verifiable_intent.models.user_mandate import (
    CheckoutMandate,
    MandateMode,
    PaymentMandate,
    UserMandate,
)

from . import errors
from .config import Settings, get_settings, now_sec
from .keys import b64u_decode, rfc7638_thumbprint
from .models import L2FinalizeRequest, L2FinalizeResponse, L2PrepareRequest, L2PrepareResponse

#: A P-256 ES256 signature is exactly 64 raw bytes: r‖s (RFC 7518 §3.4, "P1363" form). The
#: browser emits this; `cryptography` emits DER and would be 70-72 bytes.
ES256_RAW_SIGNATURE_BYTES = 64


# --- the in-memory prepare store (§8.3) ------------------------------------------------------------


@dataclass
class PrepareRecord:
    """Everything `finalize` needs, and nothing the caller can influence."""

    prepare_id: str
    signing_input: str
    l2: SdJwt
    #: The L1's `cnf.jwk` — the ONLY key whose signature will be accepted.
    device_jwk: dict[str, Any]
    agent_kid: str
    expires_at: int
    iat: int
    exp: int | None


@dataclass
class PrepareStore:
    """``prepare_id → PrepareRecord``, TTL-bounded, in memory, single process (spec §8.3).

    In memory and not in Postgres because the record is a **capability**, not state: it authorises
    exactly one signature over one specific byte string for a bounded time. Losing it on restart is
    safe — the browser simply asks `prepare` again, which is idempotent by construction (§8.4:
    "`l2/prepare` … is safe to repeat").
    """

    ttl_seconds: int
    _records: dict[str, PrepareRecord] = field(default_factory=dict)

    def put(self, record: PrepareRecord) -> None:
        self.purge()
        self._records[record.prepare_id] = record

    def get(self, prepare_id: str, *, now: int | None = None) -> PrepareRecord | None:
        """Return the record, or `None` once it has expired. Expired means gone, not usable."""
        record = self._records.get(prepare_id)
        if record is None:
            return None
        if (now if now is not None else now_sec()) >= record.expires_at:
            self._records.pop(prepare_id, None)
            return None
        return record

    def purge(self) -> int:
        """Drop expired records. Returns how many went. Cheap: called on every `prepare`."""
        now = now_sec()
        dead = [pid for pid, rec in self._records.items() if now >= rec.expires_at]
        for pid in dead:
            self._records.pop(pid, None)
        return len(dead)

    def __len__(self) -> int:
        return len(self._records)


_store: PrepareStore | None = None
_store_ttl: int | None = None


def get_prepare_store(settings: Settings | None = None) -> PrepareStore:
    """The process-wide store. Rebuilt if the configured TTL changes (tests)."""
    global _store, _store_ttl
    settings = settings or get_settings()
    if _store is None or _store_ttl != settings.prepare_ttl_seconds:
        _store = PrepareStore(ttl_seconds=settings.prepare_ttl_seconds)
        _store_ttl = settings.prepare_ttl_seconds
    return _store


def reset_prepare_store() -> None:
    """Forget every pending prepare. Tests only."""
    global _store, _store_ttl
    _store = None
    _store_ttl = None


# --- shared helpers (also used by l3.py and verify.py) ---------------------------------------------


def device_jwk_from_l1(l1: SdJwt) -> dict[str, Any]:
    """The device public key bound in the L1, or `CS_VALIDATION` if the L1 does not bind one.

    This is the value that makes `finalize` safe. It comes from a signed, issuer-issued token, not
    from the caller, which is the whole reason a substituted signature cannot work.
    """
    cnf = l1.payload.get("cnf")
    jwk = cnf.get("jwk") if isinstance(cnf, dict) else None
    if not isinstance(jwk, dict) or not jwk:
        raise errors.http_error("CS_VALIDATION", "L1 has no cnf.jwk, so it binds no device key")
    for member in ("x", "y", "crv", "kty"):
        if not isinstance(jwk.get(member), str) or not jwk[member]:
            raise errors.http_error("CS_VALIDATION", f"L1 cnf.jwk is missing the required member {member!r}")
    return jwk


@dataclass
class L2Disclosures:
    """The four disclosures an autonomous L2 is built from, plus the two role presentations.

    `create_layer2_autonomous` emits, in order: one disclosure per merchant, one per acceptable
    item, then the open checkout mandate, then the open payment mandate. The L3 sd_hashes are
    computed over *selective presentations* of those, so `l3/create` and `verify` must locate the
    same four strings — hence one function, used by both.
    """

    checkout_mandate: str
    payment_mandate: str
    merchant: str | None
    item: str | None
    base_jwt: str
    full_serialized: str
    checkout_presentation: str
    payment_presentation: str


def _disclosure_value(disc_value: list[Any]) -> Any:  # noqa: ANN401 - decoded SD-JWT disclosure, untyped by nature
    return disc_value[-1] if disc_value else None


def find_disclosures(
    l2: SdJwt,
    *,
    merchant_id: str | None = None,
    item_id: str | None = None,
) -> L2Disclosures:
    """Locate the mandate, merchant and item disclosures inside a parsed L2.

    Fails closed. `examples/helpers.py::build_role_presentations` refuses to fall back to the full
    L2 because a merchant must not see the payment mandate and the network must not see the cart;
    we keep that refusal, and additionally refuse when the cart SKU has no acceptable-item
    disclosure, because then the checkout-side sd_hash would bind to nothing the user approved.
    """
    checkout_mandate = payment_mandate = None
    merchant = None
    item = None

    for disc_str, disc_val in zip(l2.disclosures, l2.disclosure_values, strict=True):
        value = _disclosure_value(disc_val)
        if not isinstance(value, dict):
            continue
        vct = value.get("vct")
        if vct == "mandate.checkout.open.1" and checkout_mandate is None:
            checkout_mandate = disc_str
            continue
        if vct == "mandate.payment.open.1" and payment_mandate is None:
            payment_mandate = disc_str
            continue
        if "id" in value and "name" in value and "website" in value and merchant is None:
            merchant = disc_str
            continue
        if "id" in value and "title" in value and item is None:
            item = disc_str
            continue

    if checkout_mandate is None:
        raise errors.http_error(
            "VI_CHAIN_INVALID",
            "L2 carries no open checkout mandate disclosure (mandate.checkout.open.1). An "
            "autonomous mandate cannot be delegated without one.",
        )
    if payment_mandate is None:
        raise errors.http_error(
            "VI_CHAIN_INVALID",
            "L2 carries no open payment mandate disclosure (mandate.payment.open.1). An "
            "autonomous mandate cannot authorise a payment without one.",
        )

    wanted_merchant = merchant_id is not None and any(
        isinstance(_disclosure_value(v), dict) and _disclosure_value(v).get("id") == merchant_id
        for v in l2.disclosure_values
    )
    if wanted_merchant and merchant is None:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"No merchant disclosure for payee_id={merchant_id!r} inside the L2. The L2's "
            "allowed_payees constraint is resolved by SD reference, so an unlisted payee cannot be "
            "checked and must not be signed.",
            {"payee_id": merchant_id},
        )
    if item_id is not None and item is None:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"No acceptable-item disclosure for SKU={item_id!r} inside the L2. The L2's line_items "
            "constraint is resolved by SD reference, so a SKU the user did not approve cannot be "
            "signed.",
            {"sku": item_id},
        )

    full = l2.serialize()
    base = full.split("~")[0]
    # The network sees the payment mandate plus the payee it will settle to; the merchant sees the
    # checkout mandate plus the item it will ship. Each sd_hash therefore commits only to what its
    # own holder is allowed to learn, and `verify_chain` re-checks both hashes.
    return L2Disclosures(
        checkout_mandate=checkout_mandate,
        payment_mandate=payment_mandate,
        merchant=merchant,
        item=item,
        base_jwt=base,
        full_serialized=full,
        checkout_presentation=build_selective_presentation(base, [checkout_mandate, item or merchant]),
        payment_presentation=build_selective_presentation(base, [payment_mandate, merchant]),
    )


def resolve_disclosure_refs(l2: SdJwt, constraints: list[dict[str, Any]]) -> dict[str, Any]:
    """Resolve SD references inside a mandate's constraints into inline dicts.

    The library stores `allowed_merchants`/`allowed_payees` entries as `{"...": "<hash>"}`
    references, and `check_constraints` cannot match a payee against a reference — it needs the
    real merchant dicts. `examples/helpers.py::validate_intent` does the same resolution before
    calling the checker; without it, `allowed_payees` silently degrades to "skipped: no resolved
    payees", which would be a *pass* on an unchecked constraint.
    """
    from verifiable_intent.crypto.disclosure import hash_disclosure

    by_hash = {
        hash_disclosure(s): _disclosure_value(v)
        for s, v in zip(l2.disclosures, l2.disclosure_values, strict=True)
    }

    def resolve_entry(entry: Any) -> Any:  # noqa: ANN401 - walks arbitrary decoded JSON
        if isinstance(entry, dict) and "..." in entry:
            return by_hash.get(entry["..."], entry)
        if isinstance(entry, list):
            return [resolve_entry(e) for e in entry]
        if isinstance(entry, dict):
            return {k: resolve_entry(v) for k, v in entry.items()}
        return entry

    return [resolve_entry(c) for c in constraints]


# --- phase 1: prepare ------------------------------------------------------------------------------


def prepare_l2(req: L2PrepareRequest, settings: Settings | None = None) -> L2PrepareResponse:
    """Build the L2 body, sign it with a throwaway key, and hand the browser the bytes to sign."""
    settings = settings or get_settings()
    store = get_prepare_store(settings)

    try:
        l1 = decode_sd_jwt(req.l1)
    except ValueError as exc:
        raise errors.http_error("CS_VALIDATION", f"l1 is not a decodable SD-JWT: {exc}") from exc

    device_jwk = device_jwk_from_l1(l1)
    issued_at = now_sec()
    expires_at = issued_at + req.ttl_seconds

    # `mandate.checkout.open.1` / `mandate.payment.open.1`: the *open* VCTs. The library infers
    # autonomous mode from these and refuses a chain that mixes them with the immediate-mode
    # ("final") VCTs, so a mandate built here is autonomous by construction.
    checkout_mandate = CheckoutMandate(
        vct="mandate.checkout.open.1",
        cnf_jwk=req.agent_public_jwk.as_dict(),
        cnf_kid=req.agent_kid,
        constraints=[_as_constraint(c) for c in req.checkout_constraints],
    )
    payment_mandate = PaymentMandate(
        vct="mandate.payment.open.1",
        cnf_jwk=req.agent_public_jwk.as_dict(),
        cnf_kid=req.agent_kid,
        constraints=[_as_constraint(c) for c in req.payment_constraints],
        payment_instrument=req.payment_instrument.model_dump(),
        risk_data=_risk_data(req),
    )
    if not checkout_mandate.constraints:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            "checkout_constraints must contain a mandate.checkout.line_items constraint. The library "
            "refuses to sign an open checkout mandate without one, so there is nothing to delegate.",
            {"constraint_types": sorted({str(c.get("type")) for c in req.checkout_constraints})},
        )

    mandate = UserMandate(
        nonce=req.nonce,
        aud=req.aud,
        iat=issued_at,
        iss=req.iss,
        exp=expires_at,
        mode=MandateMode.AUTONOMOUS,
        # Binds this L2 to exactly this L1 presentation. `verify_chain` recomputes the hash and
        # fails closed on a mismatch, so an L2 cannot be lifted onto a different card or device.
        sd_hash=hash_bytes(req.l1.encode("ascii")),
        prompt_summary=req.prompt_summary or None,
        checkout_mandate=checkout_mandate,
        payment_mandate=payment_mandate,
        merchants=[m.model_dump() for m in req.merchants],
        acceptable_items=[i.model_dump() for i in req.acceptable_items],
    )

    # Throwaway. Its only job is to make the library produce the header/payload bytes; its
    # signature is discarded on the next line and never leaves this function.
    ephemeral = generate_es256_key()
    try:
        l2 = create_layer2_autonomous(mandate, ephemeral, kid=req.device_kid)
    except ValueError as exc:
        # `_match_merchant_refs` / `_match_item_refs` raise here when a constraint names a
        # merchant or SKU that is not in `merchants` / `acceptable_items`. That is exactly a
        # "bad constraint shape" and belongs to the caller to fix.
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"The mandate cannot be built from these constraints: {exc}",
            {"hint": "every constraint entry must match one entry in `merchants` / `acceptable_items`"},
        ) from exc

    signing_input = _signing_input_of(l2)

    prepare_id = f"prep_{uuid.uuid4().hex}"
    expires_at_prepare = issued_at + settings.prepare_ttl_seconds
    store.put(
        PrepareRecord(
            prepare_id=prepare_id,
            signing_input=signing_input,
            l2=l2,
            device_jwk=device_jwk,
            agent_kid=req.agent_kid,
            expires_at=expires_at_prepare,
            iat=issued_at,
            exp=expires_at,
        )
    )

    return L2PrepareResponse(
        prepare_id=prepare_id,
        signing_input=signing_input,
        header=dict(l2.header),
        # The decoded payload, verbatim. Spec §8.5: the UI MUST render *this*, not the client's own
        # copy of the constraints — that read-back is what makes consent informed.
        payload=dict(l2.payload),
        expires_at=expires_at_prepare,
        prepare_ttl_seconds=settings.prepare_ttl_seconds,
    )


def _as_constraint(raw: dict[str, Any]) -> Any:  # noqa: ANN401 - returns the library's base Constraint
    """Validate one constraint dict and hand back the library's own dataclass instance.

    Two hops on purpose: `validate_constraint_dict` proves the shape against our registry (and
    rejects unknown types at the edge), then `parse_constraint` re-reads it with the *library's*
    parser so the dataclass is constructed by the code that will verify it later. Going through
    `to_dict()` means the exact bytes the library signs are the ones we validated.
    """
    from verifiable_intent.models.constraints import parse_constraint

    from .models import validate_constraint_dict

    validated = validate_constraint_dict(raw)
    return parse_constraint(validated.to_library_dict())


def _risk_data(req: L2PrepareRequest) -> dict[str, Any] | None:
    """`risk_data` lives only on the L2, never on the L3 — the library's model enforces that."""
    if not req.device_id and not req.ip_address:
        return None
    data: dict[str, Any] = {}
    if req.device_id:
        data["device_id"] = req.device_id
    if req.ip_address:
        data["ip_address"] = req.ip_address
    return data


def _signing_input_of(l2: SdJwt) -> str:
    """`header.payload` — exactly the bytes the browser signs, from the library's own encoding.

    Read out of `issuer_jwt` rather than re-encoded from `header`/`payload`, because the compact
    JSON the library signed and the segments it keeps raw are the same bytes. Re-encoding here
    would risk a key-order or separator difference that only shows up as a signature failure in the
    browser, with nothing in the logs to explain it.
    """
    parts = l2.issuer_jwt.split(".")
    if len(parts) != 3:  # pragma: no cover - _jwt_encode always emits three
        raise errors.http_error("CS_VALIDATION", "The built L2 is not a three-segment JWS")
    return f"{parts[0]}.{parts[1]}"


# --- phase 2: finalize -----------------------------------------------------------------------------


def finalize_l2(req: L2FinalizeRequest, settings: Settings | None = None) -> L2FinalizeResponse:
    """Verify the browser's signature against the L1's device key, then return the L2.

    Order matters and is the security property of this route:

    1. the ``prepare_id`` must exist and be unexpired (otherwise `CS_NOT_FOUND`, nothing leaks);
    2. the signature must be exactly 64 raw bytes (P1363), not DER;
    3. the signature must verify against the **L1's** key, not against anything from this request;
    4. only then is the token assembled and returned.

    Steps 2 and 3 both happen before a byte of the L2 is disclosed.
    """
    settings = settings or get_settings()
    store = get_prepare_store(settings)

    record = store.get(req.prepare_id)
    if record is None:
        raise errors.http_error(
            "CS_NOT_FOUND",
            f"No pending L2 for prepare_id {req.prepare_id!r}, or it expired after "
            f"{settings.prepare_ttl_seconds}s. Ask for /v1/l2/prepare again.",
            {"prepare_ttl_seconds": settings.prepare_ttl_seconds},
        )

    try:
        signature = b64u_decode(req.signature_b64url)
    except Exception as exc:  # noqa: BLE001 - base64 failure is a validation error
        raise errors.http_error("CS_VALIDATION", f"signature_b64url is not valid base64url: {exc}") from exc

    # `es256_verify` returns False for a wrong length rather than raising, so without this the
    # caller would get `VI_SIGNATURE_MISMATCH` for what is really a malformed request. DER
    # signatures from `cryptography` land here too, which is why the message says "raw r‖s".
    if len(signature) != ES256_RAW_SIGNATURE_BYTES:
        raise errors.http_error(
            "CS_VALIDATION",
            f"signature_b64url must decode to exactly {ES256_RAW_SIGNATURE_BYTES} raw bytes "
            f"(r‖s, P1363); got {len(signature)}. A DER signature is the wrong encoding.",
            {"signature_bytes": len(signature), "expected_bytes": ES256_RAW_SIGNATURE_BYTES},
        )

    signing_input_bytes = record.signing_input.encode("ascii")
    try:
        device_pub = jwk_to_public_key(record.device_jwk)
    except (KeyError, ValueError, TypeError) as exc:
        raise errors.http_error(
            "CS_VALIDATION", f"The device key bound in the L1 is unusable: {exc}"
        ) from exc

    try:
        ok = es256_verify(signing_input_bytes, signature, device_pub)
    except Exception:  # noqa: BLE001 - a crafted signature must be a mismatch, never a 500
        ok = False

    if not ok:
        # No token, no disclosures, no partial state. This is the answer that makes two-phase
        # signing safe rather than a signature-attachment gadget.
        raise errors.http_error(
            "VI_SIGNATURE_MISMATCH",
            "The signature does not verify against the device key bound in this mandate's L1. "
            "Sign the exact `signing_input` bytes with the same key that was enrolled.",
            {"prepare_id": req.prepare_id, "device_jkt": rfc7638_thumbprint(record.device_jwk)},
        )

    return L2FinalizeResponse(
        l2=_assemble_l2(record, req.signature_b64url),
        iat=record.iat,
        exp=record.exp,
        agent_kid=record.agent_kid,
    )


def _assemble_l2(record: PrepareRecord, signature_b64url: str) -> str:
    """The finished SD-JWT: the browser's signature, plus the disclosures the library generated.

    The disclosures are not optional decoration — the two open mandates *are* disclosures, so a token
    without them carries no mandate at all and `verify_chain` reports "L2 delegate_payload resolved
    zero mandate disclosures". Splicing the signature into the library's own `serialize()` output
    (rather than reassembling from parts) means the disclosure order and the trailing `~` framing are
    exactly what the library produced, and only the signature segment is ours.
    """
    _, _, disclosures = record.l2.serialize().partition("~")
    return f"{record.signing_input}.{signature_b64url}~{disclosures}"


def decode_l2(l2_serialized: str) -> SdJwt:
    """Decode an L2 from a request, turning a parse failure into `CS_VALIDATION`."""
    try:
        return decode_sd_jwt(l2_serialized)
    except ValueError as exc:
        raise errors.http_error("CS_VALIDATION", f"l2 is not a decodable SD-JWT: {exc}") from exc
