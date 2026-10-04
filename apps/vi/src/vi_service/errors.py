"""One error contract for both runtimes (spec §8.0 rule 3, §8.1 M1).

`packages/core/src/errors.ts` is the registry. This module is a line-for-line Python mirror of
it: the same closed code set, the same `userMessage` copy, the same `retryable` defaults, and the
same body shape that `toBody()` produces. If you change one, change the other, and note it in
`docs/DECISIONS.md`.

Body shape, byte-for-byte what TypeScript emits:

    {"error": {"code": …, "message": …, "userMessage": …, "retryable": …, "details"?: {…}}}

Two rules that exist because this body crosses a trust boundary into a browser:

* `details` is scrubbed. A `details` bag can hold anything, including a `cause` or a key called
  `access_token` that somebody threaded through by mistake. Mirrors `safeDetails` in core.
* `message` is for operators; `userMessage` is the only field a buyer ever sees.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal, get_args

from fastapi import HTTPException

# --- the closed registry (packages/core/src/errors.ts, CS_ERROR_CODES) ---------------------------

CsErrorCode = Literal[
    "CS_VALIDATION",
    "CS_NOT_FOUND",
    "CS_CONFLICT",
    "CS_UNAUTHENTICATED",
    "CS_FORBIDDEN",
    "CS_CURRENCY_MISMATCH",
    "CS_ROUNDING",
    # Added in docs/DECISIONS.md D-007. These were missing here while present in
    # packages/core, which meant vi could never emit them: the rate limiter had to borrow
    # PP_RATE_LIMITED (whose user-facing copy blames PayPal for our own limit) and an unhandled 500
    # was reported as CS_VALIDATION, i.e. told to a user as "check your input" for a server fault.
    "CS_RATE_LIMITED",
    "CS_INTERNAL",
    "VI_CHAIN_INVALID",
    "VI_SIGNATURE_MISMATCH",
    "VI_EXPIRED",
    "VI_NOT_YET_VALID",
    "VI_CONSTRAINT_VIOLATION",
    "GATE_BLOCKED",
    "GATE_REPLAY",
    "GATE_BUDGET_EXCEEDED",
    "GATE_REVOKED",
    "GATE_PRICE_LOCK_EXPIRED",
    "GATE_OUT_OF_STOCK",
    "GATE_AGENT_SUSPENDED",
    "GATE_WALLET_CAP",
    "PP_AUTH",
    "PP_RATE_LIMITED",
    "PP_UNAVAILABLE",
    "PP_UNPROCESSABLE",
    "PP_DUPLICATE",
    "PP_NOT_FOUND",
    "PP_INSTRUMENT_DECLINED",
    "PP_PAYER_ACTION_REQUIRED",
    "PP_AUTH_EXPIRED",
    "WH_SIGNATURE_INVALID",
    "WH_DUPLICATE",
    "DEF_NO_CHAIN",
    "DEF_CITATION_FAILED",
    "DEF_DEADLINE_PASSED",
    "DEF_WRONG_STATE",
    "LLM_SCHEMA",
    "LLM_UNAVAILABLE",
    "PRIVACY_LEGAL_HOLD",
]

#: Runtime membership set, so a typo becomes a `KeyError` at construction instead of a wire format
#: the TypeScript side has never heard of. Derived from the `Literal` above, which is the single
#: place a code is spelled.
CS_ERROR_CODES: frozenset[str] = frozenset(get_args(CsErrorCode))

#: Codes a retry can fix. Everything else needs a human or a different request.
_RETRYABLE: frozenset[str] = frozenset(
    {"PP_RATE_LIMITED", "PP_UNAVAILABLE", "LLM_UNAVAILABLE", "CS_RATE_LIMITED"}
)

#: Buyer-facing copy. Mirrors `USER_MESSAGES` in core; a code with no entry falls back to the
#: generic sentence so a new code can never leak an internal message to a user.
_USER_MESSAGES: dict[str, str] = {
    "CS_VALIDATION": "Some of that information is not valid. Please check and try again.",
    "CS_NOT_FOUND": "We could not find that. It may have been removed.",
    "CS_CONFLICT": "That conflicts with something we already saved. Refresh and try again.",
    "CS_UNAUTHENTICATED": "Please sign in and try again.",
    "CS_FORBIDDEN": "You do not have access to that.",
    "CS_CURRENCY_MISMATCH": (
        "Your limit and this purchase are in different currencies, so we did not convert them. "
        "Create a mandate in the store currency."
    ),
    "CS_ROUNDING": "That amount has more decimal places than its currency allows, so we refused to round it.",
    "CS_RATE_LIMITED": "Too many requests just now. Please wait a moment and try again.",
    "CS_INTERNAL": (
        "Something went wrong on our side. Nothing was charged. We have the details and will fix it."
    ),
    "VI_CHAIN_INVALID": "The signed mandate could not be verified, so we stopped.",
    "VI_SIGNATURE_MISMATCH": "The signature did not match the key in the mandate, so we stopped.",
    "VI_EXPIRED": "Your mandate expired. Ask for a new one and we will continue.",
    "VI_NOT_YET_VALID": "That mandate is not valid yet.",
    "VI_CONSTRAINT_VIOLATION": "This purchase is outside the limits you signed.",
    "GATE_BLOCKED": "The merchant’s Gate blocked this purchase. The reasons are listed for you.",
    "GATE_REPLAY": "This exact authorisation was already used once, so it was not used again.",
    "GATE_BUDGET_EXCEEDED": "This purchase would take you past the limit you signed.",
    "GATE_REVOKED": "You revoked this mandate, so nothing further can be charged under it.",
    "GATE_PRICE_LOCK_EXPIRED": "The locked price expired, so the agent needs to re-quote.",
    "GATE_OUT_OF_STOCK": "That item just sold out.",
    "GATE_AGENT_SUSPENDED": "That agent is suspended, so it cannot spend right now.",
    "GATE_WALLET_CAP": "This purchase would pass your wallet-level cap.",
    "PP_AUTH": "We could not authorise with PayPal. Please try again shortly.",
    "PP_RATE_LIMITED": "PayPal is asking us to slow down. We will retry automatically.",
    "PP_UNAVAILABLE": "PayPal is having trouble. Nothing is charged twice; we will retry.",
    "PP_UNPROCESSABLE": "PayPal rejected the request details.",
    "PP_DUPLICATE": "That request was already made.",
    "PP_NOT_FOUND": "PayPal could not find that record.",
    "PP_INSTRUMENT_DECLINED": "PayPal declined the payment. Nothing was charged. Update PayPal and retry.",
    "PP_PAYER_ACTION_REQUIRED": "PayPal needs you to approve something before this can complete.",
    "PP_AUTH_EXPIRED": "The authorisation expired before it was captured, so it was released.",
    "WH_SIGNATURE_INVALID": "A webhook failed its signature check and was rejected.",
    "WH_DUPLICATE": "That webhook was already processed.",
    "DEF_NO_CHAIN": "We cannot prove what was authorised for this payment.",
    "DEF_CITATION_FAILED": "The draft evidence contained claims without a source, so it was not filed.",
    "DEF_DEADLINE_PASSED": "PayPal’s response deadline has passed.",
    "DEF_WRONG_STATE": "This dispute is not in a state where that action is allowed.",
    "LLM_SCHEMA": "The model’s answer did not match the expected shape, so we asked again.",
    "LLM_UNAVAILABLE": "The model is unavailable. You can do this part by hand.",
    "PRIVACY_LEGAL_HOLD": "We must keep this record for now because a dispute needs it.",
}

_DEFAULT_USER_MESSAGE = "Something went wrong. Nothing was charged. Please try again."

#: Unanchored on purpose: `access_token` and `x-api-key` must be caught, not just the bare words.
#:
#: This list was supposed to be a strict superset of `NEVER_SERIALISE` in packages/core, and now
#: actually is. It previously missed `kid`, `client_id` and `session_id`, which core strips — so a
#: `details.kid` would have been redacted by the TypeScript side and leaked by this one. The two
#: regexes are asserted to agree by `tests/test_errors.py::test_never_serialise_is_a_superset_of_core`.
_NEVER_SERIALISE = re.compile(
    r"(cause|stack|secret|password|token|authorization|cookie|credential|private"
    r"|key|kid|client_id|session_id|clientid)",
    re.IGNORECASE,
)

#: HTTP status per code.
#:
#: `CS_RATE_LIMITED` carries 429 (docs/DECISIONS.md D-007). It previously had to borrow
#: `CS_CONFLICT`, whose user-facing copy tells the user to refresh — advice that is actively wrong
#: when the cause is that we asked for too many things too quickly.
_STATUS: dict[str, int] = {
    "CS_RATE_LIMITED": 429,
    "CS_INTERNAL": 500,
    "CS_VALIDATION": 400,
    "CS_ROUNDING": 400,
    "CS_CURRENCY_MISMATCH": 400,
    "CS_UNAUTHENTICATED": 401,
    "CS_FORBIDDEN": 403,
    "CS_NOT_FOUND": 404,
    "CS_CONFLICT": 409,
    "VI_SIGNATURE_MISMATCH": 400,
    "VI_CHAIN_INVALID": 422,
    "VI_EXPIRED": 422,
    "VI_NOT_YET_VALID": 422,
    "VI_CONSTRAINT_VIOLATION": 422,
}


@dataclass(frozen=True)
class CsError:
    """The error that crosses a module boundary. Mirrors `CsError` in core."""

    code: CsErrorCode
    #: Precise, for logs and evidence packets. Never shown raw to a buyer.
    message: str
    #: Safe to render to a buyer or merchant. No secrets, no internal ids.
    user_message: str
    #: Whether retrying the same request could succeed. Drives backoff and UI advice.
    retryable: bool
    details: dict[str, Any] | None = None

    def to_body(self) -> dict[str, Any]:
        """The exact shape `toBody()` emits in TypeScript. Keys, order and all."""
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "userMessage": self.user_message,
            "retryable": self.retryable,
        }
        safe = safe_details(self.details)
        if safe is not None:
            error["details"] = safe
        return {"error": error}


def safe_details(details: dict[str, Any] | None) -> dict[str, Any] | None:
    """Strip anything that must never cross the trust boundary. Mirrors core's `safeDetails`."""
    if not details:
        return None
    out: dict[str, Any] = {}
    for key, value in details.items():
        if _NEVER_SERIALISE.search(key):
            continue
        out[key] = value
    return out or None


def cs_error(
    code: CsErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
    *,
    user_message: str | None = None,
    retryable: bool | None = None,
    status_code: int | None = None,
) -> CsError:
    """Build a `CsError`. `details` is a separate argument on purpose (core §8.1 note)."""
    if code not in CS_ERROR_CODES:  # pragma: no cover - guards a typo at the call site
        raise KeyError(f"{code!r} is not in the CS_ERROR_CODES registry")
    return CsError(
        code=code,
        message=message,
        user_message=user_message if user_message is not None else _USER_MESSAGES[code],
        retryable=retryable if retryable is not None else code in _RETRYABLE,
        details=details,
    )


def status_for(code: CsErrorCode) -> int:
    return _STATUS.get(code, 400)


def http_error(
    code: CsErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
    *,
    user_message: str | None = None,
    retryable: bool | None = None,
    status_code: int | None = None,
    headers: dict[str, str] | None = None,
) -> HTTPException:
    """The one place a `CsError` becomes an HTTP response."""
    err = cs_error(code, message, details, user_message=user_message, retryable=retryable)
    return HTTPException(
        status_code=status_code if status_code is not None else status_for(code),
        detail=err.to_body(),
        headers=headers,
    )


def is_error_body(value: Any) -> bool:  # noqa: ANN401 - it interrogates an arbitrary exception detail
    """True when `value` is already a serialised `CsErrorBody` (so a handler passes it through)."""
    return (
        isinstance(value, dict)
        and set(value) == {"error"}
        and isinstance(value["error"], dict)
        and "code" in value["error"]
        and "message" in value["error"]
    )
