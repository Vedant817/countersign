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

Disclosure completeness
----------------------
A JWS signature covers ``header.payload`` and nothing else, so **SD-JWT disclosures are unsigned
and the presenter chooses which ones travel**. Per spec §3.1 the presenter is the agent, the
untrusted party. This module therefore also owns the completeness gate
(:func:`incomplete_disclosures`): it derives every disclosure hash the signed bytes commit to and
requires each to be present. SD-JWT gives no completeness guarantee of its own, so a verifier that
skips this check can be handed a narrowed presentation in which a constraint the user signed
resolves to nothing and is silently not evaluated. See the section comment above
:func:`committed_disclosure_refs` for why the committed set is exactly the ``{"...": hash}``
placeholders and deliberately not the ``_sd`` array.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from verifiable_intent.crypto.disclosure import (
    build_selective_presentation,
    hash_bytes,
    hash_disclosure,
)
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


# --- SD-JWT presentation completeness ----------------------------------------------------------------
#
# Why this section exists (spec §8.3, §8.0 rule 4)
# -------------------------------------------------
# A JWS signature covers `header.payload` and nothing else. SD-JWT disclosures live *after* the
# `~`, so **the party presenting the token chooses which disclosures travel with it** — and per spec
# §3.1 that party is the agent, the untrusted one. The signed payload commits to
# `hash(merchant)`; SD-JWT itself requires nothing about that disclosure being *present*.
#
# Left alone, that is not a theoretical gap. `allowed_payees` is stored as `{"...": hash}`
# references, the reference checker cannot match a payee against a reference, and the pinned
# library treats "every entry is an unresolved reference" as *skip and pass*
# (`verification/constraint_checker.py`, `if all_sd_refs: … return`). So the presenter could
# withhold one string from the part of the token nobody signed and turn the payee allow-list — the
# constraint that decides **who gets paid** — into an unbounded agent authority, with the verifier
# reporting it as `checked`.
#
# The fix is completeness, not filtering. This module derives the set of hashes the *signed bytes*
# commit to and requires each to be present; `verify` refuses the chain if any is missing. Nothing
# here decides which constraints to run or narrows what is evaluated.

#: The key the library writes for a selectively disclosable value it did not inline: `{"...": hash}`.
SD_REF_KEY = "..."

#: Stable, greppable prefix on the refusal. `CsError.code` is a closed registry (spec §8.0 rule 3),
#: so an incomplete presentation cannot have its own code — it is `VI_CHAIN_INVALID` — and this
#: string is what makes the reason findable in a log or an evidence packet.
INCOMPLETE_PRESENTATION_PREFIX = "incomplete SD-JWT presentation"

#: Node budget for the reference walk. An adversarial payload can nest arbitrarily deep, and a
#: recursive walk would turn that into a `RecursionError` (a 500) rather than a verdict. The budget
#: makes "too large to prove complete" an explicit refusal, which is the correct direction.
_REF_WALK_NODE_BUDGET = 20_000


class DisclosureCompletenessError(ValueError):
    """A disclosure the signature commits to was not presented.

    Raised instead of letting an unresolved `{"...": hash}` travel further into constraint
    evaluation, where the pinned library would treat it as a pass. Carries the layer name and the
    missing hashes so a caller can report them without re-deriving anything.
    """

    def __init__(self, *, layer: str, missing: list[str]) -> None:
        self.layer = layer
        self.missing = missing
        detail = ", ".join(h[:12] + ".." for h in missing)
        super().__init__(
            f"{INCOMPLETE_PRESENTATION_PREFIX}: the signed {layer} commits to {len(missing)} "
            f"disclosure(s) that the presentation does not contain ({detail})."
        )


class RefWalkTooLarge(ValueError):
    """The token is larger than the completeness walk will traverse."""


def _collect_sd_refs(root: Any, out: set[str]) -> None:  # noqa: ANN401 - walks arbitrary decoded JSON
    """Add every `{"...": "<hash>"}` reachable from `root` to `out`. Iterative, budgeted."""
    nodes = 0
    stack: list[Any] = [root]
    while stack:
        node = stack.pop()
        nodes += 1
        if nodes > _REF_WALK_NODE_BUDGET:
            raise RefWalkTooLarge(f"more than {_REF_WALK_NODE_BUDGET} nodes")
        if isinstance(node, dict):
            ref = node.get(SD_REF_KEY)
            if isinstance(ref, str) and ref:
                out.add(ref)
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


def committed_disclosure_refs(sd_jwt: SdJwt) -> set[str]:
    """Every disclosure hash the **signed bytes** commit to, wherever the commitment lives.

    Two places, both inside signature coverage:

    1. ``payload.delegate_payload`` — the L2/L3 mandate disclosures. The signed payload proper.
    2. Inside a **presented** disclosure — an ``allowed_payees`` / ``allowed_merchants`` /
       ``line_items`` entry is a `{"...": hash}` placeholder living inside the mandate disclosure.
       That mandate disclosure is itself hash-committed by ``delegate_payload``, so its bytes are
       authenticated even though the hash of the claim it points at is not. Walking in is
       therefore sound, and it is the only way to see the payee allow-list references at all.

    Which hashes are *not* here, and why
    ------------------------------------
    The top-level ``_sd`` array is deliberately excluded. SD-JWT uses it for two different things
    that the token itself cannot tell apart:

    * the digest of a claim that travels as a disclosure (the L2's merchant and item entries, and
      both open mandates — every one of which is *also* reachable from a `{"...": …}` placeholder),
      and
    * the digest of a claim the issuer disclosed **by digest**, leaving the value inline in the
      payload. ``create_layer1`` does exactly this for the L1's ``email``: ``payload["_sd"]`` holds
      the digest of ``[salt, "email", …]`` and the address is never inlined.

    There is no way to tell these two apart from the token, because the array holds only hashes and
    a disclosure hash is taken over the whole disclosure string *including a random 16-byte salt*
    (``crypto/disclosure.py::create_disclosure`` calls ``os.urandom(16)``), so the digest cannot be
    inverted or even matched against a candidate. Demanding every ``_sd`` entry be presented would
    therefore refuse the L1's own ``email`` — a claim the issuer never intended to be a disclosure
    at all — while adding nothing an attacker could use, because every disclosure carrying authority
    or a constraint is reachable from a placeholder.

    A placeholder has no such ambiguity. `{"...": h}` *is* the SD-JWT encoding of "the value is not
    in this token; it is in the disclosure with this hash". So a placeholder in the signed bytes
    with no matching disclosure in the presentation is not a judgement call about presentation
    policy — it is a commitment the signature made and the presenter withheld. That is what this
    gate refuses, and it is decidable in both directions.
    """
    refs: set[str] = set()
    _collect_sd_refs(sd_jwt.payload, refs)
    for disc_value in sd_jwt.disclosure_values:
        _collect_sd_refs(disc_value, refs)
    return refs


def missing_disclosures(sd_jwt: SdJwt) -> list[str]:
    """Committed disclosure hashes the presentation does not contain. Sorted; may be empty."""
    refs = committed_disclosure_refs(sd_jwt)
    if not refs:
        return []
    presented = {hash_disclosure(d) for d in sd_jwt.disclosures}
    return sorted(refs - presented)


def incomplete_disclosures(sd_jwt: SdJwt, *, layer: str) -> list[str]:
    """Reasons the presentation is incomplete for `layer`. Empty means complete.

    Absence, not substitution, is the question. Presenting a *different* disclosure for a committed
    hash needs a SHA-256 preimage, and reordering changes no hash, so an extra or reordered
    disclosure is already inert; what matters is that nothing the signature promised is missing.
    """
    missing = missing_disclosures(sd_jwt)
    if not missing:
        return []
    detail = ", ".join(h[:12] + ".." for h in missing)
    return [
        f"{INCOMPLETE_PRESENTATION_PREFIX}: the signed {layer} commits to {len(missing)} disclosure(s) "
        f"by hash and the presentation does not contain them ({detail}). SD-JWT disclosures are not "
        f"signed, so their absence is the presenter's choice; a constraint that resolved by reference "
        f"cannot be enforced, and an unenforced constraint is unbounded agent authority "
        f"(spec §8.3, §8.0 rule 4). Present the complete token."
    ]


def require_complete_presentation(sd_jwt: SdJwt, *, layer: str) -> None:
    """Raise ``DisclosureCompletenessError`` unless every committed disclosure is presented."""
    missing = missing_disclosures(sd_jwt)
    if missing:
        raise DisclosureCompletenessError(layer=layer, missing=missing)


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
    # The library hard-codes exactly two disclosures per selective presentation
    # (`build_selective_presentation(base, [a, b])` -> `"~".join([base, a, b])`), and each L3's
    # `sd_hash` is taken over exactly those two. So a presentation cannot be built at all without a
    # merchant, and the checkout side needs an item or a merchant.
    #
    # Refusing here is the whole fix for what used to be an unauthenticated 500: the old code passed
    # `item or merchant` straight into the join, so a presentation with no merchant disclosure left
    # `None` in the list and `"~".join` raised `TypeError`, which escaped `verify`'s
    # `HTTPException` handler and reached FastAPI as a 500 on the public verifier. A chain the
    # verifier cannot slice is an invalid chain, and an invalid chain is a 200 with reasons.
    if merchant is None:
        raise errors.http_error(
            "VI_CHAIN_INVALID",
            "The L2 carries no merchant disclosure (id + name + website), so no selective "
            "presentation can be built: the library's presentation is exactly two disclosures and "
            "the second one must be a merchant the user signed. The presentation is therefore not "
            "verifiable, whatever the rest of the chain says.",
            {"missing": "merchant_disclosure"},
        )
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


class UnresolvedDisclosureRef(ValueError):
    """A `{"...": hash}` reference survived resolution because its disclosure is not presented.

    The old behaviour returned the *reference itself* on a miss, so `allowed_payees` reached
    `check_constraints` as `[{"...": "<hash>"}]`. The pinned library then treats "every entry is an
    SD ref" as a skip that leaves `satisfied` true — a silent pass on the constraint that decides
    who may be paid. A reference that resolves to itself is a pass waiting to happen, so this
    raises instead. Callers translate it into whatever their contract is: a chain error on
    `/v1/verify`, a 422 on `l3/create`.
    """

    def __init__(self, refs: list[str]) -> None:
        self.refs = refs
        super().__init__(
            f"{len(refs)} SD reference(s) did not resolve against the presented disclosures "
            f"({', '.join(r[:12] + '..' for r in refs)})"
        )


def resolve_disclosure_refs(l2: SdJwt, constraints: list[dict[str, Any]]) -> list[Any]:
    """Resolve SD references inside a mandate's constraints into inline dicts.

    The library stores `allowed_merchants`/`allowed_payees` entries as `{"...": "<hash>"}`
    references, and `check_constraints` cannot match a payee against a reference — it needs the
    real merchant dicts. `examples/helpers.py::validate_intent` does the same resolution before
    calling the checker; without it, `allowed_payees` silently degrades to "skipped: no resolved
    payees", which would be a *pass* on an unchecked constraint.

    **Fails closed.** An unresolved reference raises :class:`UnresolvedDisclosureRef` rather than
    travelling on as `{"...": hash}`. That fallback was the first of the three fail-opens in the
    disclosure-narrowing bypass; the completeness gate in :func:`incomplete_disclosures` should mean
    this never fires, which is exactly why it is worth keeping as a second, independent refusal.
    """
    by_hash = {
        hash_disclosure(s): _disclosure_value(v)
        for s, v in zip(l2.disclosures, l2.disclosure_values, strict=True)
    }
    unresolved: list[str] = []

    def resolve_entry(entry: Any) -> Any:  # noqa: ANN401 - walks arbitrary decoded JSON
        if isinstance(entry, dict) and SD_REF_KEY in entry:
            ref = entry[SD_REF_KEY]
            if isinstance(ref, str) and ref in by_hash:
                return by_hash[ref]
            if isinstance(ref, str):
                unresolved.append(ref)
            return entry
        if isinstance(entry, list):
            return [resolve_entry(e) for e in entry]
        if isinstance(entry, dict):
            return {k: resolve_entry(v) for k, v in entry.items()}
        return entry

    resolved = [resolve_entry(c) for c in constraints]
    if unresolved:
        raise UnresolvedDisclosureRef(sorted(set(unresolved)))
    return resolved


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
