"""The FastAPI app: routes, auth, rate limiting, error bodies (spec §8.3).

Route table (spec §8.3, verbatim; AT-M3 covers all of them):

======================================  =====  ====================================================
Route                                   Auth   Purpose
======================================  =====  ====================================================
``POST   /v1/keys/agent``               bearer  Mint + KEK-encrypt one agent key
``POST   /v1/keys/rotate``              bearer  Retire the current ISSUER/MERCHANT key, mint a new one
``POST   /v1/l1/issue``                 bearer  Issuer signs L1
``POST   /v1/l2/prepare``               bearer  Build the L2 body; hand the browser the bytes
``POST   /v1/l2/finalize``              bearer  Verify the browser's signature, return L2
``POST   /v1/checkout-jwt``             bearer  Merchant signs the price-locked checkout JWT
``POST   /v1/l3/create``                bearer  Pre-check, then sign L3a + L3b
``POST   /v1/verify``                   bearer  verify_chain + check_constraints (STRICT)
``GET    /v1/jwks``                     PUBLIC  All public keys, retired ones included with `status`
``POST   /v1/public/verify``            PUBLIC  Same verdict plus `bundle_hash`
``GET    /v1/status``                   PUBLIC  Liveness + the EC-TIME-2 clock-skew probe
======================================  =====  ====================================================

Two rules that are easy to get wrong and are enforced centrally here rather than per route:

* **Every error body is a `CsErrorBody`.** FastAPI's default 422 is a completely different shape
  from `packages/core`'s `toBody()`, and a caller written against one would break on the other. The
  handlers below convert *everything*, including FastAPI's own validation errors, so there is
  exactly one error contract on the wire.
* **`/v1/verify` never 4xxes on a bad chain.** Only on a bad *request*.
"""

from __future__ import annotations

import secrets
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import errors, ratelimit
from .checkout_jwt import create_checkout_jwt, verify_checkout_signature
from .config import now_sec
from .keys import get_keystore
from .l1 import issue_l1
from .l2 import finalize_l2, prepare_l2
from .l3 import create_l3
from .models import (
    CheckoutJwtRequest,
    CheckoutJwtResponse,
    JwksResponse,
    L1IssueRequest,
    L1IssueResponse,
    L2FinalizeRequest,
    L2FinalizeResponse,
    L2PrepareRequest,
    L2PrepareResponse,
    L3CreateRequest,
    L3CreateResponse,
    MintAgentKeyRequest,
    MintAgentKeyResponse,
    PublicVerifyRequest,
    PublicVerifyResponse,
    RotateKeyRequest,
    RotateKeyResponse,
    StatusResponse,
    VerifyRequest,
    VerifyResponse,
)
from .verify import public_verify, verify

API_TITLE = "Countersign vi-service"
API_VERSION = "1.0.0"

app = FastAPI(
    title=API_TITLE,
    version=API_VERSION,
    description=(
        "The crypto oracle for Verifiable Intent (spec D2, §8.3). Signs L1/L2/L3 and verifies "
        "chains. Stateless except for its keys."
    ),
)


# --- dependencies -----------------------------------------------------------------------------------


def require_bearer(authorization: Annotated[str | None, Header()] = None) -> None:
    """`Authorization: Bearer ${VI_SERVICE_TOKEN}` on every route except the two public ones.

    Compared with `secrets.compare_digest`, so a wrong token costs the same time as a right one
    rather than leaking its prefix through a short-circuit.
    """
    from .config import get_settings

    expected = get_settings().service_token
    if not authorization:
        raise errors.http_error(
            "CS_UNAUTHENTICATED",
            "Missing Authorization header. This route needs `Authorization: Bearer $VI_SERVICE_TOKEN`.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(value.strip(), expected):
        raise errors.http_error(
            "CS_UNAUTHENTICATED",
            "Invalid bearer token for this route.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def enforce_public_limit(request: Request) -> None:
    """30 req/min/IP, per spec §8.3. Applied only to `GET /v1/jwks` and `POST /v1/public/verify`.

    The client identity comes from `ratelimit.client_id_for` with the configured
    `VI_TRUSTED_PROXY_HOPS`, which defaults to 0 — so by default the socket address is the only
    identity and `X-Forwarded-For` cannot be used to mint fresh budgets.
    """
    from .config import get_settings

    ratelimit.enforce(
        ratelimit.client_id_for(
            request.client.host if request.client else None,
            request.headers.get("x-forwarded-for"),
            trusted_hops=get_settings().trusted_proxy_hops,
        )
    )


Private = Depends(require_bearer)
Public = Depends(enforce_public_limit)


# --- error handlers: one contract on the wire ---------------------------------------------------------


@app.exception_handler(errors.HTTPException)
async def _cs_http_exception(_request: Request, exc: errors.HTTPException) -> JSONResponse:
    """Every `errors.http_error` we raise lands here with its `CsErrorBody` intact."""
    return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)


@app.exception_handler(StarletteHTTPException)
async def _starlette_http_exception(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Wrap a Starlette/FastAPI HTTPException that is not already a `CsErrorBody`.

    404 on an unknown path and 405 on a wrong method land here. They get the same contract as
    everything else, so a client never has to branch on which layer produced the error.
    """
    if errors.is_error_body(exc.detail):
        return JSONResponse(status_code=exc.status_code, content=exc.detail, headers=exc.headers)
    err = errors.cs_error(
        "CS_NOT_FOUND" if exc.status_code == 404 else "CS_VALIDATION",
        f"{exc.status_code} {exc.detail}",
    )
    return JSONResponse(status_code=exc.status_code, content=err.to_body(), headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """FastAPI's 422 body is `{"detail": [...]}`, which no Countersign client parses.

    Converted to `CS_VALIDATION` with the same envelope. Only `loc`, `msg` and `type` are copied:
    pydantic's `input` echoes the caller's raw value, and on this service that could be a token or
    a ciphertext.
    """
    fields = [
        {
            "loc": [str(part) for part in err.get("loc", ())],
            "msg": err.get("msg", ""),
            "type": err.get("type", ""),
        }
        for err in exc.errors()
    ]
    err = errors.cs_error(
        "CS_VALIDATION",
        f"Request body failed validation ({len(fields)} problem(s)): "
        + "; ".join(f"{'.'.join(f['loc']) or '<root>'}: {f['msg']}" for f in fields),
        {"fields": fields},
    )
    return JSONResponse(status_code=400, content=err.to_body())


@app.exception_handler(Exception)
async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
    """Last resort. No traceback, no exception text, nothing from the environment.

    Reported as `CS_INTERNAL`, not `CS_VALIDATION` (docs/DECISIONS.md D-007). An exception reaching
    this handler is our bug, and telling the caller their request was invalid sends whoever is
    debugging it to look at the wrong thing — while counting every server fault as a user error in
    the metrics. Nothing was signed, and the response says so.
    """
    err = errors.cs_error(
        "CS_INTERNAL",
        f"The service failed to handle this request ({type(exc).__name__}). Nothing was signed.",
    )
    return JSONResponse(status_code=500, content=err.to_body())


# --- keys --------------------------------------------------------------------------------------------


@app.post("/v1/keys/agent", response_model=MintAgentKeyResponse, dependencies=[Private], tags=["keys"])
def mint_agent_key(req: MintAgentKeyRequest) -> MintAgentKeyResponse:
    """Mint one P-256 key per agent instance. The plaintext private key never leaves this process."""
    import base64

    entry, blob = get_keystore().mint_agent_key(req.agent_id)
    return MintAgentKeyResponse(
        kid=entry.kid,
        public_jwk=entry.public_jwk,
        enc_private_key_b64=base64.b64encode(blob).decode("ascii"),
    )


@app.post("/v1/keys/rotate", response_model=RotateKeyResponse, dependencies=[Private], tags=["keys"])
def rotate_key(req: RotateKeyRequest) -> RotateKeyResponse:
    """Retire the current key for a role and mint a replacement.

    Nothing is deleted: the retired public key stays resolvable by `kid` and stays in JWKS, so
    evidence signed before the rotation still verifies (spec EC-KEY-2, EC-KEY-3).
    """
    store = get_keystore()
    previous = store.current_kid(req.role)
    entry = store.rotate(req.role)
    return RotateKeyResponse(new_kid=entry.kid, role=req.role, retired_kid=previous)


@app.get("/v1/jwks", response_model=JwksResponse, dependencies=[Public], tags=["keys"])
def jwks() -> JwksResponse:
    """Issuer, merchant and every agent key — **including retired ones**, each with a `status`.

    Public and rate-limited (spec §8.3): a verifier needs the retired keys to check old evidence,
    and a public key set is not a secret.
    """
    return JwksResponse(**get_keystore().jwks())


# --- L1 ----------------------------------------------------------------------------------------------


@app.post("/v1/l1/issue", response_model=L1IssueResponse, dependencies=[Private], tags=["l1"])
def l1_issue(req: L1IssueRequest) -> L1IssueResponse:
    """Issuer signs an L1 binding `sub`, the device public key (`cnf.jwk`) and `card_id`."""
    return issue_l1(req)


# --- L2, two-phase -----------------------------------------------------------------------------------


@app.post("/v1/l2/prepare", response_model=L2PrepareResponse, dependencies=[Private], tags=["l2"])
def l2_prepare(req: L2PrepareRequest) -> L2PrepareResponse:
    """Build the L2 body and return `header.payload` for the browser to sign (spec D3)."""
    return prepare_l2(req)


@app.post("/v1/l2/finalize", response_model=L2FinalizeResponse, dependencies=[Private], tags=["l2"])
def l2_finalize(req: L2FinalizeRequest) -> L2FinalizeResponse:
    """Verify the browser's signature against the L1 device key, then return the L2.

    A signature that does not verify yields `VI_SIGNATURE_MISMATCH` and **no token**. That check is
    what makes two-phase signing safe instead of a way to attach an arbitrary signature.
    """
    return finalize_l2(req)


# --- checkout JWT ------------------------------------------------------------------------------------


@app.post("/v1/checkout-jwt", response_model=CheckoutJwtResponse, dependencies=[Private], tags=["checkout"])
def checkout_jwt(req: CheckoutJwtRequest) -> CheckoutJwtResponse:
    """Merchant signs the price lock. Integer minor units throughout (spec EC-FX-6)."""
    return create_checkout_jwt(req)


# --- L3 ----------------------------------------------------------------------------------------------


@app.post("/v1/l3/create", response_model=L3CreateResponse, dependencies=[Private], tags=["l3"])
def l3_create(req: L3CreateRequest) -> L3CreateResponse:
    """Pre-check against the L2's constraints, then sign L3a (payment) and L3b (checkout).

    `VI_CONSTRAINT_VIOLATION` when the request is out of mandate: the service refuses to sign
    rather than signing and letting the Gate catch it later.
    """
    return create_l3(req)


# --- verify ------------------------------------------------------------------------------------------


@app.post("/v1/verify", response_model=VerifyResponse, dependencies=[Private], tags=["verify"])
def verify_chain_route(req: VerifyRequest) -> VerifyResponse:
    """`verify_chain` + `check_constraints(mode=STRICT)`.

    An invalid chain is `200 {chain_valid: false, errors: [...]}` — never a 4xx. Only a malformed
    request is a 4xx.
    """
    return verify(req)


@app.post("/v1/public/verify", response_model=PublicVerifyResponse, dependencies=[Public], tags=["verify"])
def public_verify_route(req: PublicVerifyRequest) -> PublicVerifyResponse:
    """Public, rate-limited, for `/v/{packetId}`. Same checks, plus `bundle_hash` (spec §7.3)."""
    return public_verify(req)


# --- status ------------------------------------------------------------------------------------------


@app.get("/v1/status", response_model=StatusResponse, tags=["ops"])
def status() -> StatusResponse:
    """Liveness, the kids in force, and the skew `VI_CLOCK_SKEW_SECONDS` is actually using.

    EC-TIME-2 asks for a clock comparison between web and vi. This reports what vi believes; the
    caller compares it with its own `Date` header. The bounded skew is what makes a 5 s drift
    harmless (spec §12.5).
    """
    from .config import get_settings

    settings = get_settings()
    store = get_keystore()
    return StatusResponse(
        ok=True,
        app_env=settings.app_env,
        issuer_kid=store.current_kid("ISSUER"),
        merchant_kid=store.current_kid("MERCHANT"),
        clock_skew_seconds=settings.clock_skew_seconds,
    )


@app.get("/v1/checkout-jwt/verify", dependencies=[Private], tags=["checkout"])
def checkout_jwt_verify(checkout_jwt: str) -> dict[str, Any]:
    """Does this price lock verify against a merchant key we know?

    A diagnostic for WP-09's checkout work, on the private authenticated surface so it cannot be used
    as a free signing oracle by the public. Always answers `{valid, reason}` — a price lock that does
    not even parse is a `valid: false` answer here, not a 4xx, because the whole point of the endpoint
    is to be asked "is this thing good?" and get told.
    """
    try:
        ok, why = verify_checkout_signature(checkout_jwt)
    except errors.HTTPException as exc:
        ok, why = False, exc.detail["error"]["message"]
    return {"valid": ok, "reason": why, "checked_at": now_sec()}


__all__ = ["app", "require_bearer", "enforce_public_limit"]
