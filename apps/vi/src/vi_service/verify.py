"""Chain verification (spec §8.3 `POST /v1/verify` and `POST /v1/public/verify`).

Three properties this module is built around.

**1. An invalid chain is a 200, never a 4xx.** Spec §8.3 is explicit: `/v1/verify` returns
`chain_valid: false` with reason strings. A verifier that 400s on bad evidence is a verifier you
cannot point a judge's tool at. So decode failures, unknown keys and constraint violations are all
*results*, not exceptions. Only a malformed *request* is a 4xx.

**2. Constraints run in STRICT mode.** Spec §8.3: "verify MUST call
`check_constraints(..., mode=StrictnessMode.STRICT)`". A constraint type the library does not know
is a violation, not a shrug — an unknown constraint is unbounded agent authority, which is exactly
what a prompt-injected L3 would like (spec §12.9, §8.0 rule 4).

**3. `at_time` is reported honestly, not approximated.** See :data:`AT_TIME_NOT_HONOURED_REASON`.

**4. The presented disclosures must be complete.** A JWS signature covers `header.payload` only, so
an SD-JWT's disclosures are outside it and the presenter picks them (spec §3.1: the presenter is the
agent, the untrusted party). Without a completeness gate, withholding one disclosure turns
`allowed_payees` / `allowed_merchants` into a pass, because the pinned library treats "every entry is
an unresolved SD ref" as *skip and return* with `satisfied` still true. So
:func:`assert_presentations_complete` runs before any constraint is evaluated and a missing
committed disclosure is a chain error. See `l2.py` for why the committed set is the
`{"...": hash}` placeholders and not the `_sd` array.

**5. `checked` only ever contains bare, registered constraint types.** A consumer that writes
``checked.includes('mandate.payment.allowed_payees')`` must be able to rely on it meaning *evaluated*.
The library appends both ``'mandate.payment.allowed_payees'`` and
``'mandate.payment.allowed_payees (skipped: no resolved payees)'`` when it declines to evaluate, so
an exact-match membership test used to return ``true`` while nothing was enforced —
precisely the trap :class:`~vi_service.models.SkippedConstraint`'s docstring says the type/reason
split exists to remove. :func:`_partition_checked` is the invariant, and
``tests/test_verify.py::test_EC_CONS_complete_a_skipped_constraint_never_satisfies_checked_includes``
asserts it directly.

``budget``, ``recurrence`` and ``agent_recurrence``
--------------------------------------------------
The library appends these three to ``checked`` while evaluating **none** of them — its own source
comment says "Network-enforced constraints". Reporting them as checked would tell the Gate its job
is done. So :func:`classify_constraint_report` moves them into ``skipped`` with the reason, and the
Gate — which enforces them itself per spec D19 — can see what it still owes (spec §8.8 [B3]).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from verifiable_intent.crypto.sd_jwt import SdJwt, decode_sd_jwt, resolve_disclosures
from verifiable_intent.verification.chain import verify_chain
from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints

from . import errors
from .checkout_jwt import (
    checkout_hash_from_jwt,
    decode_checkout_jwt_header,
    decode_checkout_jwt_payload,
    verify_checkout_signature,
)
from .config import Settings, get_settings, now_sec
from .keys import b64u_encode, get_keystore, rfc7638_thumbprint
from .l2 import (
    INCOMPLETE_PRESENTATION_PREFIX as _INCOMPLETE_PREFIX,
)
from .l2 import (
    RefWalkTooLarge,
    UnresolvedDisclosureRef,
    find_disclosures,
    incomplete_disclosures,
    resolve_disclosure_refs,
)
from .models import (
    CONSTRAINT_TYPES,
    NETWORK_ENFORCED_CONSTRAINTS,
    AtTimeCheck,
    ConstraintReport,
    DisclosedReport,
    KeyReport,
    PublicVerifyRequest,
    PublicVerifyResponse,
    SkippedConstraint,
    VerifyRequest,
    VerifyResponse,
)

_AT_TIME_REASON = (
    "verify_chain() at the pinned commit 356c296 has no clock override: it reads time.time() "
    "internally (verification/chain.py, `now = int(time.time())`). The chain was therefore "
    "verified at the current time only. at_time_check.within_validity_at is our own iat/exp window "
    "check at the requested instant and is ADVISORY, not a second chain verdict. A real as-of "
    "verification needs a `now` parameter in the library; see docs/HUMAN_TODO.md."
)

#: Public, because the Defender cites it verbatim in an evidence packet (EC-TIME-3).
AT_TIME_NOT_HONOURED_REASON = _AT_TIME_REASON


#: ``"<type> (…)"`` — the shape the pinned library uses to say "I appended this to `checked` but
#: evaluated nothing", e.g. ``"mandate.payment.allowed_payees (skipped: no resolved payees)"``.
_SKIP_ANNOTATION = re.compile(r"^(?P<type>\S+)\s+\((?P<why>[^()]*)\)$")

#: Every registered constraint type, for the `checked` invariant in :func:`_partition_checked`.
_REGISTERED = frozenset(CONSTRAINT_TYPES)


def _partition_checked(checked: list[str]) -> tuple[list[str], list[SkippedConstraint]]:
    """Split the library's `checked` into what was really evaluated and what was not.

    The invariant this enforces, and the whole reason it exists:

    > For every constraint in the report, ``checked.includes(name)`` with an exact match means the
    > constraint was *evaluated*.

    The pinned library breaks that in two ways. It appends the bare type *and then* an annotated
    ``"<type> (skipped: …)"`` when it declines to evaluate — `_check_allowed_payee` and
    `_check_allowed_merchant` both do `result.checked.append(ctype)` and then, a few lines later,
    `return` on the unresolved-SD-ref branch with `satisfied` untouched — so `checked` held both and
    an exact-match membership test returned `true` while nothing was enforced. And it appends the
    three network-enforced types it never evaluates at all.

    So: an annotated entry is split into `SkippedConstraint(type, reason)` using the *bare* type,
    and anything that is not a registered constraint type is moved out too. Nothing is dropped —
    an unrecognised string is never evidence of an evaluation, so it goes to `skipped` with a
    reason saying so.
    """
    # Two passes, because the library's damage is a *pair*: it appends the bare type and then, from
    # inside the same function, an annotated `"<type> (skipped: …)"`. The annotated entry is the
    # evidence that the constraint was not evaluated, so the bare twin has to go too — keeping it is
    # precisely the `checked.includes('mandate.payment.allowed_payees') == true` trap.
    annotated_types = {
        match.group("type")
        for match in (_SKIP_ANNOTATION.match(name.strip()) for name in checked)
        if match and match.group("type") in _REGISTERED
    }

    kept: list[str] = []
    moved: list[SkippedConstraint] = []
    for name in checked:
        match = _SKIP_ANNOTATION.match(name.strip())
        if match and match.group("type") in _REGISTERED:
            moved.append(
                SkippedConstraint(
                    type=match.group("type"),
                    reason=(
                        f"Not evaluated: {match.group('why')}. The constraint is signed but its "
                        "referenced disclosures were not presented, so it could not be enforced; an "
                        "unenforced constraint is unbounded agent authority (spec §8.3, §8.0 rule 4)."
                    ),
                )
            )
        elif name in annotated_types:
            # The bare twin of an annotated skip. Reported once, by the annotated entry.
            continue
        elif name not in _REGISTERED:
            moved.append(
                SkippedConstraint(
                    type=name,
                    reason=(
                        "Not a registered constraint type, so it cannot be reported as evaluated. "
                        "Treated as unenforced (spec §8.8: exactly 8 registered types)."
                    ),
                )
            )
        else:
            kept.append(name)
    return kept, moved


def classify_constraint_report(checked: list[str], skipped: list[str]) -> list[SkippedConstraint]:
    """Everything that was not evaluated, in the only shape the wire uses.

    Returns the corrected `skipped` list.

    Three sources feed it: the bare type strings the library already put in `skipped`, the three
    network-enforced types it wrongly puts in `checked`, and any annotated `"<type> (…)"` entry it
    appended to `checked` instead of evaluating. Every entry is a `SkippedConstraint`, so a consumer
    never has to handle a bare string and an annotated string in the same array — and, more to the
    point, `checked` can no longer contain a constraint that was not evaluated. See
    `SkippedConstraint` in models.py and :func:`_partition_checked`.
    """
    moved: list[SkippedConstraint] = [
        SkippedConstraint(type=name, reason="Not evaluated by the verification request.") for name in skipped
    ]
    bare, annotated = _partition_checked(checked)
    moved.extend(annotated)
    for name in bare:
        if name in NETWORK_ENFORCED_CONSTRAINTS:
            moved.append(
                SkippedConstraint(
                    type=name,
                    reason=(
                        "Network-enforced constraint. Not evaluated by verifiable_intent; "
                        "Countersign's Gate enforces it (spec D19). NOT satisfied by this response."
                    ),
                )
            )
    return moved


def assert_presentations_complete(tokens: dict[str, SdJwt | None]) -> list[str]:
    """Chain errors for any token whose presentation is missing a committed disclosure.

    Runs on **all four** tokens, not just the L2, and runs before `verify_chain` and before any
    constraint evaluation. Order matters for the property, not for the verdict: a presentation that
    is incomplete is not a verdict about anything else, and evaluating constraints against it is
    what produced the bypass in the first place.

    Reporting rather than raising is deliberate. `/v1/verify`'s contract is that an invalid chain is
    a 200 with reasons, and `/v1/public/verify` inherits it; a refusal that arrived as an exception
    would either 500 or be swallowed, and neither is an answer a judge can read.
    """
    problems: list[str] = []
    for layer, token in tokens.items():
        if token is None:
            continue
        try:
            problems.extend(incomplete_disclosures(token, layer=layer))
        except RefWalkTooLarge as exc:
            problems.append(
                f"incomplete SD-JWT presentation: the {layer} is too deeply nested to prove "
                f"complete ({exc}). A presentation we cannot check is not a presentation we can "
                f"accept (spec §8.0 rule 4)."
            )
    return problems


def _skip(category: str, reason: str) -> list[SkippedConstraint]:
    """One skipped evaluation category, in the only shape the wire uses."""
    return [SkippedConstraint(type=category, reason=reason)]


def _constraint_report(
    constraints: list[dict[str, Any]], fulfilment: dict[str, Any], *, side: str
) -> ConstraintReport:
    """One STRICT-mode evaluation.

    An empty constraint list is not "satisfied"; it is "nothing to check", which is a different
    statement and must never be reported as a pass.
    """
    if not constraints:
        return ConstraintReport(
            satisfied=False,
            violations=[f"No {side} constraints were disclosed, so none could be enforced"],
            checked=[],
            skipped=_skip(f"{side}_constraints", "No disclosed constraints, so none could be enforced"),
        )
    result = check_constraints(constraints, fulfilment, mode=StrictnessMode.STRICT)
    bare, _moved = _partition_checked(result.checked)
    return ConstraintReport(
        satisfied=result.satisfied,
        violations=list(result.violations),
        checked=[n for n in bare if n not in NETWORK_ENFORCED_CONSTRAINTS],
        skipped=classify_constraint_report(result.checked, result.skipped),
    )


# --- at_time (EC-TIME-3) -----------------------------------------------------------------------------


def _within_validity(claims: dict[str, Any], at: int, skew: int) -> bool:
    """Our own iat/exp window check, mirroring the library's `_is_expired` / `_is_future_dated`.

    Conservative in the same direction the library is: `exp + skew` is still valid, `iat - skew` is
    not yet valid. Only a boolean comes back — a caller must not read this as a verdict.
    """
    exp = claims.get("exp")
    iat = claims.get("iat")
    if isinstance(exp, int) and not isinstance(exp, bool) and at > exp + skew:
        return False
    not_yet_valid = isinstance(iat, int) and not isinstance(iat, bool) and iat > at + skew
    return not not_yet_valid


def _at_time_check(
    at_time: int | None, l1_claims: dict[str, Any], l2_claims: dict[str, Any], skew: int
) -> AtTimeCheck | None:
    """EC-TIME-3. See :data:`AT_TIME_NOT_HONOURED_REASON`.

    The honest shape of the answer is: "I verified at `now`; here is whether the validity window
    would have covered your `at_time`, computed by us and not by the chain verifier." Anything
    stronger would be a silent wrong answer, and a silent wrong answer inside an evidence packet is
    worse than no answer at all.
    """
    if at_time is None:
        return None
    now = now_sec()

    def exp_int(claims: dict[str, Any]) -> int | None:
        value = claims.get("exp")
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    return AtTimeCheck(
        requested=at_time,
        honoured=False,
        reason=_AT_TIME_REASON,
        within_validity_at=_within_validity(l1_claims, at_time, skew)
        and _within_validity(l2_claims, at_time, skew),
        within_validity_now=_within_validity(l1_claims, now, skew) and _within_validity(l2_claims, now, skew),
        l1_exp=exp_int(l1_claims),
        l2_exp=exp_int(l2_claims),
    )


# --- decoding ---------------------------------------------------------------------------------------


def _decode_all(req: VerifyRequest) -> tuple[Any, Any, Any, Any, list[str]]:
    """Decode the four tokens. A parse failure is a chain error, not an exception."""
    decoded: list[Any] = []
    problems: list[str] = []
    for name, value in (("l1", req.l1), ("l2", req.l2), ("l3a", req.l3a), ("l3b", req.l3b)):
        if value is None:
            decoded.append(None)
            continue
        try:
            decoded.append(decode_sd_jwt(value))
        except ValueError as exc:
            decoded.append(None)
            problems.append(f"{name} is not a decodable SD-JWT: {exc}")
    return decoded[0], decoded[1], decoded[2], decoded[3], problems


def _kid_of(sd_jwt: SdJwt) -> str | None:
    value = sd_jwt.header.get("kid")
    return value if isinstance(value, str) else None


def _find_vct(claims: dict[str, Any], vct: str) -> dict[str, Any] | None:
    for delegate in claims.get("delegate_payload", []) or []:
        if isinstance(delegate, dict) and delegate.get("vct") == vct:
            return delegate
    return None


def _device_jkt(l1_claims: dict[str, Any]) -> str | None:
    cnf = l1_claims.get("cnf")
    jwk = cnf.get("jwk") if isinstance(cnf, dict) else None
    if not isinstance(jwk, dict):
        return None
    try:
        return rfc7638_thumbprint(jwk)
    except ValueError:
        return None


def _agent_kid(l2_claims: dict[str, Any]) -> str | None:
    for vct in ("mandate.checkout.open.1", "mandate.payment.open.1"):
        mandate = _find_vct(l2_claims, vct)
        if mandate is None:
            continue
        cnf = mandate.get("cnf")
        jwk = cnf.get("jwk") if isinstance(cnf, dict) else None
        if isinstance(jwk, dict) and isinstance(jwk.get("kid"), str):
            return jwk["kid"]
    return None


# --- the route --------------------------------------------------------------------------------------


def _safe_checkout(checkout_jwt: str | None) -> tuple[dict[str, Any] | None, list[str]]:
    """Decode the checkout JWT's payload, or report why not.

    A price lock that does not decode is an **invalid chain**, not a malformed request, so this
    returns problems for `errors` instead of raising. Spec §8.3 is unambiguous: `/v1/verify` never
    4xxes on an invalid chain, and a tampered JWT is exactly the case AT-M3.7 is about.
    """
    if checkout_jwt is None:
        return None, []
    try:
        return decode_checkout_jwt_payload(checkout_jwt), []
    except errors.HTTPException as exc:
        return None, [exc.detail["error"]["message"]]


def verify(req: VerifyRequest, settings: Settings | None = None) -> VerifyResponse:
    """Verify a chain. Always returns a verdict; never raises for a bad chain."""
    settings = settings or get_settings()
    store = get_keystore()
    skew = settings.clock_skew_seconds
    now = now_sec()

    l1, l2, l3a, l3b, chain_errors = _decode_all(req)
    cart, cart_errors = _safe_checkout(req.checkout_jwt)
    chain_errors.extend(cart_errors)

    # The completeness gate, before anything is evaluated. A chain missing a disclosure its own
    # signature commits to is not a chain whose constraints mean anything, so this is recorded
    # before `verify_chain` and before `_constraints` and short-circuits them both: reporting a
    # narrowed presentation as "constraints satisfied, nothing to report" is the bug.
    chain_errors.extend(assert_presentations_complete({"l1": l1, "l2": l2, "l3a": l3a, "l3b": l3b}))

    if l1 is None or l2 is None:
        return VerifyResponse(
            chain_valid=False,
            errors=chain_errors,
            constraints=ConstraintReport(
                satisfied=False,
                violations=["The chain did not parse, so no constraint could be enforced"],
                checked=[],
                skipped=_skip("all_checks", "The chain did not decode, so nothing could be verified"),
            ),
            disclosed=DisclosedReport(),
            keys=KeyReport(),
            verified_at=now,
            clock_skew_seconds=skew,
            at_time_not_honoured=req.at_time is not None,
            at_time_reason=_AT_TIME_REASON if req.at_time is not None else None,
        )

    # Resolve the issuer key from the L1's own `kid`, so a chain signed by a *retired* issuer key
    # still verifies (EC-KEY-2). `verify_chain` only takes a public key, so the lookup happens here
    # and a failure becomes a chain error, never an exception.
    issuer_kid = _kid_of(l1)
    issuer_public = store.public_key_by_kid(issuer_kid) if issuer_kid else None
    if issuer_public is None:
        chain_errors.append(
            f"no usable issuer key for kid {issuer_kid!r}; the L1 cannot be attributed to an issuer"
        )

    l2_payment_serialized = l2_checkout_serialized = None
    if l3a is not None or l3b is not None:
        try:
            disclosures = find_disclosures(
                l2,
                merchant_id=_cart_field(cart, "merchant", "id"),
                item_id=_cart_first_sku(cart),
            )
            l2_payment_serialized = disclosures.payment_presentation
            l2_checkout_serialized = disclosures.checkout_presentation
        except errors.HTTPException as exc:
            chain_errors.append(exc.detail["error"]["message"])
        except Exception as exc:  # noqa: BLE001 - a public verifier must never 500 (spec §8.3)
            chain_errors.append(
                f"L2 disclosure layout could not be read: {type(exc).__name__}: {exc}. The chain is "
                "not verifiable as presented."
            )

    result = None
    if issuer_public is not None:
        try:
            result = verify_chain(
                l1,
                l2,
                l3_payment=l3a,
                l3_checkout=l3b,
                issuer_public_key=issuer_public,
                clock_skew_seconds=skew,
                l1_serialized=req.l1,
                l2_serialized=req.l2,
                l2_payment_serialized=l2_payment_serialized,
                l2_checkout_serialized=l2_checkout_serialized,
                expected_l2_aud=req.expected_aud,
                expected_l2_nonce=req.expected_nonce,
            )
            chain_errors.extend(result.errors)
        except Exception as exc:  # noqa: BLE001 - a verifier must never 500 on adversarial input
            chain_errors.append(f"chain verification raised {type(exc).__name__}: {exc}")

    l1_claims = result.l1_claims if result else resolve_disclosures(l1)
    l2_claims = result.l2_claims if result else resolve_disclosures(l2)
    l3a_claims = result.l3_payment_claims if result else (resolve_disclosures(l3a) if l3a else {})
    l3b_claims = result.l3_checkout_claims if result else (resolve_disclosures(l3b) if l3b else {})

    checkout_errors, merchant_kid = _check_checkout_binding(req, cart, l3b_claims)
    chain_errors.extend(checkout_errors)

    # An incomplete presentation is a verification failure, not a licence to evaluate what is left.
    # Reporting a narrowed L2's constraints as "satisfied" is exactly the bypass, so once the gate
    # has fired the constraint report says so instead of running a partial evaluation.
    presentation_incomplete = any(e.startswith(_INCOMPLETE_PREFIX) for e in chain_errors)

    if presentation_incomplete:
        report = ConstraintReport(
            satisfied=False,
            violations=[
                "The chain was not evaluated: the presentation omits a disclosure the signed "
                "payload commits to, so no constraint can be enforced. An incomplete "
                "presentation is not a valid chain (spec §8.3, §8.0 rule 4)."
            ],
            checked=[],
            skipped=_skip(
                "all_constraint_checks",
                "Not evaluated, because the presented disclosures are incomplete. A constraint "
                "whose referenced disclosure is absent cannot be enforced, and reporting it as "
                "satisfied would be unbounded agent authority.",
            ),
        )
    else:
        report = _constraints(req, cart, l2, l2_claims, l3a_claims)

    return VerifyResponse(
        chain_valid=bool(result and result.valid and not chain_errors and report.satisfied),
        errors=chain_errors,
        constraints=report,
        disclosed=DisclosedReport(l1=l1_claims, l2=l2_claims, l3a=l3a_claims, l3b=l3b_claims),
        keys=KeyReport(
            issuer_kid=issuer_kid,
            device_jkt=_device_jkt(l1_claims),
            agent_kid=_agent_kid(l2_claims),
            device_kid=_kid_of(l2),
            merchant_kid=merchant_kid,
        ),
        checks_performed=list(result.checks_performed) if result else [],
        checks_skipped=list(result.checks_skipped) if result else [],
        verified_at=now,
        clock_skew_seconds=skew,
        at_time_not_honoured=req.at_time is not None,
        at_time_reason=_AT_TIME_REASON if req.at_time is not None else None,
        at_time_check=_at_time_check(req.at_time, l1_claims, l2_claims, skew),
    )


def _check_checkout_binding(
    req: VerifyRequest, cart: dict[str, Any] | None, l3b_claims: dict[str, Any]
) -> tuple[list[str], str | None]:
    """Recompute `checkout_hash` from the JWT and compare it with what L3b committed to.

    This is AT-M3.7, and it is the check that makes a one-byte edit to the price lock fatal. The
    merchant signature alone would also catch that; the hash comparison is the *binding* — it says
    the price the mandate authorised is the price in this exact token, not merely that some valid
    merchant signed some token.
    """
    out: list[str] = []
    if req.checkout_jwt is None:
        return out, None

    try:
        header = decode_checkout_jwt_header(req.checkout_jwt)
        header_kid = header.get("kid") if isinstance(header.get("kid"), str) else None
    except errors.HTTPException as exc:
        out.append(exc.detail["error"]["message"])
        return out, None

    ok, why = verify_checkout_signature(req.checkout_jwt)
    if not ok:
        out.append(f"checkout JWT signature invalid: {why}")

    if cart is None:
        # Already reported by `_safe_checkout`; nothing further can be compared.
        return out, header_kid

    if not l3b_claims:
        out.append("checkout_jwt was supplied but no l3b, so nothing commits to this price lock")
        return out, header_kid

    committed = None
    for delegate in l3b_claims.get("delegate_payload", []) or []:
        if isinstance(delegate, dict) and delegate.get("vct") == "mandate.checkout.1":
            committed = delegate.get("checkout_hash")
            break
    if not isinstance(committed, str) or not committed:
        out.append("l3b carries no checkout mandate disclosure, so it commits to no checkout_hash")
        return out, header_kid

    recomputed = checkout_hash_from_jwt(req.checkout_jwt)
    if recomputed != committed:
        out.append(
            f"checkout_hash mismatch: the checkout JWT hashes to {recomputed} but the L3b "
            f"mandate committed to {committed}"
        )
    return out, header_kid


def _unresolved_side_report(side: str, subject: str, exc: UnresolvedDisclosureRef) -> ConstraintReport:
    """The report for a side whose constraint references did not all resolve.

    `satisfied: False` and a named `skipped` entry — never a bare ``"<type> (skipped: …)"`` string in
    ``checked``. The library's own answer to this situation is skip-and-pass
    (``constraint_checker.py``: ``if all_sd_refs: … return`` with ``satisfied`` untouched), and that
    is the second fail-open in the disclosure-narrowing bypass. An allow-list we cannot read is not
    an allow-list we can honour, so the correct report is "nothing authorised here".
    """
    return ConstraintReport(
        satisfied=False,
        violations=[
            f"{side.capitalize()} constraints could not be enforced: a signed SD reference did not "
            f"resolve against the presented disclosures ({exc}). The {subject} is unenforceable, so "
            "nothing is authorised (spec §8.3, §8.0 rule 4)."
        ],
        checked=[],
        skipped=_skip(
            f"{side}_constraints",
            "Not evaluated, because a signed SD reference inside the mandate did not resolve to a "
            "presented disclosure. This is a refusal, not a pass: the constraint is signed and "
            "unenforceable, which is unbounded agent authority.",
        ),
    )


def _constraints(
    req: VerifyRequest,
    cart: dict[str, Any] | None,
    l2: SdJwt,
    l2_claims: dict[str, Any],
    l3a_claims: dict[str, Any],
) -> ConstraintReport:
    """Payment-side and checkout-side constraints, STRICT, against the resolved L3 fulfilment."""
    reports: list[ConstraintReport] = []

    payment_mandate = _find_vct(l2_claims, "mandate.payment.open.1") or _find_vct(
        l2_claims, "mandate.payment.1"
    )
    if payment_mandate is None:
        reports.append(
            ConstraintReport(
                satisfied=False,
                violations=["No payment mandate disclosure was found in the L2"],
                checked=[],
                skipped=_skip("payment_constraints", "No L2 payment mandate was disclosed"),
            )
        )
    else:
        # Fail closed. The completeness gate above should already have refused this chain; this is
        # the independent second refusal, so that a future path into `_constraints` that skipped the
        # gate still cannot turn an unreadable payee allow-list into a pass.
        try:
            payment_constraints = resolve_disclosure_refs(l2, payment_mandate.get("constraints") or [])
        except UnresolvedDisclosureRef as exc:
            reports.append(_unresolved_side_report("payment", "payee allow-list", exc))
        else:
            constraints = [c for c in payment_constraints if isinstance(c, dict)]
            fulfilment = _find_vct(l3a_claims, "mandate.payment.1") or {}
            if not fulfilment and l3a_claims:
                fulfilment = {"delegate_payload": l3a_claims.get("delegate_payload", [])}
            reports.append(_constraint_report(constraints, fulfilment, side="payment"))

    checkout_mandate = _find_vct(l2_claims, "mandate.checkout.open.1") or _find_vct(
        l2_claims, "mandate.checkout.1"
    )
    if checkout_mandate is None:
        reports.append(
            ConstraintReport(
                satisfied=False,
                violations=["No checkout mandate disclosure was found in the L2"],
                checked=[],
                skipped=_skip("checkout_constraints", "No L2 checkout mandate was disclosed"),
            )
        )
    elif req.checkout_jwt is None:
        reports.append(
            ConstraintReport(
                satisfied=False,
                violations=["Checkout constraints could not be enforced: no checkout_jwt was supplied"],
                checked=[],
                skipped=_skip("checkout_constraints", "Needs the checkout_jwt cart, which was not supplied"),
            )
        )
    elif cart is None:
        reports.append(
            ConstraintReport(
                satisfied=False,
                violations=["Checkout constraints could not be enforced: the checkout JWT does not decode"],
                checked=[],
                skipped=_skip("checkout_constraints", "The checkout JWT does not decode"),
            )
        )
    else:
        try:
            checkout_constraints = resolve_disclosure_refs(l2, checkout_mandate.get("constraints") or [])
        except UnresolvedDisclosureRef as exc:
            reports.append(_unresolved_side_report("checkout", "merchant allow-list", exc))
        else:
            constraints = [c for c in checkout_constraints if isinstance(c, dict)]
            items = (cart.get("cart") or {}).get("items") or []
            reports.append(
                _constraint_report(
                    constraints,
                    {
                        "merchant": (cart.get("cart") or {}).get("merchant") or cart.get("merchant"),
                        "line_items": [{"id": i.get("sku"), "quantity": i.get("quantity")} for i in items],
                        "checkout_jwt": req.checkout_jwt,
                        "checkout_hash": checkout_hash_from_jwt(req.checkout_jwt),
                    },
                    side="checkout",
                )
            )

    violations = [v for r in reports for v in r.violations]
    return ConstraintReport(
        satisfied=all(r.satisfied for r in reports) and not violations,
        violations=violations,
        checked=[n for r in reports for n in r.checked],
        skipped=[n for r in reports for n in r.skipped],
    )


def _cart_field(cart: dict[str, Any] | None, container: str, field: str) -> str | None:
    """One string field from the checkout JWT's cart, wherever the merchant sits."""
    if cart is None:
        return None
    merchant = (cart.get("cart") or {}).get(container) or cart.get(container) or {}
    value = merchant.get(field) if isinstance(merchant, dict) else None
    return value if isinstance(value, str) else None


def _cart_first_sku(cart: dict[str, Any] | None) -> str | None:
    if cart is None:
        return None
    items = (cart.get("cart") or {}).get("items") or []
    for item in items:
        if isinstance(item, dict) and isinstance(item.get("sku"), str):
            return item["sku"]
    return None


# --- public verify ----------------------------------------------------------------------------------


def public_verify(req: PublicVerifyRequest, settings: Settings | None = None) -> PublicVerifyResponse:
    """The public `/v/{packetId}` path: the same verdict, plus `bundle_hash`.

    Identical crypto to `/v1/verify` — no check is relaxed for the public route, because the public
    verifier is exactly where a relaxed check would be found.
    """
    inner = VerifyRequest(
        l1=req.bundle.l1,
        l2=req.bundle.l2,
        l3a=req.bundle.l3a,
        l3b=req.bundle.l3b,
        checkout_jwt=req.bundle.checkout_jwt,
        expected_aud=req.expected_aud,
        expected_nonce=req.expected_nonce,
        at_time=req.at_time,
        strict=True,
    )
    result = verify(inner, settings)
    payload = result.model_dump()
    return PublicVerifyResponse(**payload, bundle_hash=bundle_hash(req.bundle.model_dump()))


def bundle_hash(bundle: dict[str, Any]) -> str:
    """base64url SHA-256 over the RFC 8785 (JCS) canonical form of a bundle (spec §7.3).

    The same value the Gate writes into `evidence_packets.bundle_hash` and into the PayPal order's
    `custom_id` (`"cs1:" + this`), so a public verifier recomputes the identical string.

    JCS, minimally: keys sorted, no insignificant whitespace, and **no floats**. A float would make
    the hash depend on a formatting decision, and this service has no floats because money is
    integer minor units (EC-FX-6). One is refused rather than serialised in a way that might not
    match the TypeScript side.
    """
    try:
        canonical = _jcs(bundle)
    except _JcsUnsupported as exc:
        raise errors.http_error(
            "CS_VALIDATION", f"The evidence bundle cannot be canonicalised for hashing: {exc}"
        ) from exc
    return b64u_encode(hashlib.sha256(canonical).digest())


class _JcsUnsupported(ValueError):
    """A value RFC 8785 would have to format as a number, which we refuse to guess at."""


def _jcs(value: Any) -> bytes:  # noqa: ANN401 - RFC 8785 walks arbitrary JSON
    """RFC 8785 §3.2.2 serialisation, restricted to the value types a bundle may contain."""
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, int):
        return str(value).encode("ascii")
    if isinstance(value, float):
        raise _JcsUnsupported(f"float {value!r} would need RFC 8785 number formatting")
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if isinstance(value, list | tuple):
        return b"[" + b",".join(_jcs(v) for v in value) + b"]"
    if isinstance(value, dict):
        # RFC 8785 sorts by UTF-16 code unit. Bundle keys are ASCII by construction, where that is
        # identical to Python's code-point ordering.
        for key in value:
            if not isinstance(key, str):
                raise _JcsUnsupported(f"object key {key!r} is not a string")
        parts = [
            json.dumps(k, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b":" + _jcs(value[k])
            for k in sorted(value)
        ]
        return b"{" + b",".join(parts) + b"}"
    raise _JcsUnsupported(f"unsupported type {type(value).__name__}")


__all__ = [
    "AT_TIME_NOT_HONOURED_REASON",
    "assert_presentations_complete",
    "bundle_hash",
    "classify_constraint_report",
    "public_verify",
    "verify",
]
