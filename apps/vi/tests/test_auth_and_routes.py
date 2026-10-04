"""AT-M3.10 and AT-M3.11: the prepare TTL, the bearer boundary, and the rate limit.

Also the place where the error contract is pinned down. `packages/core`'s `toBody()` is the
reference, and this file is where the two runtimes are held to it: one error shape, everywhere, on
every status code, including the ones FastAPI would otherwise answer in its own format.
"""

from __future__ import annotations

import json

import pytest
from conftest import SERVICE_TOKEN, error_body
from fastapi.testclient import TestClient

from vi_service import config, ratelimit
from vi_service.errors import CS_ERROR_CODES

PRIVATE_ROUTES = [
    ("POST", "/v1/keys/agent", {"agent_id": "agt_x"}),
    ("POST", "/v1/keys/rotate", {"role": "ISSUER"}),
    (
        "POST",
        "/v1/l1/issue",
        {
            "user_id": "usr_x",
            "wallet": {"payer_id": "P", "payer_email": "a@b.test", "payment_token_id": "t"},
            "device_public_jwk": {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "B" * 43},
        },
    ),
    ("POST", "/v1/l2/prepare", {}),
    ("POST", "/v1/l2/finalize", {}),
    ("POST", "/v1/checkout-jwt", {}),
    ("POST", "/v1/l3/create", {}),
    ("POST", "/v1/verify", {}),
]


# ====================================================================================================
# AT-M3.11 — the bearer boundary
# ====================================================================================================


def test_AT_M3_11_missing_bearer_token_is_rejected(client) -> None:
    """AT-M3.11 — no `Authorization` header means 401 and a `CS_UNAUTHENTICATED` body.

    Spec §8.3: every route needs `Authorization: Bearer ${VI_SERVICE_TOKEN}` except `GET /v1/jwks` and
    `POST /v1/public/verify`. This is the test that stops an unauthenticated caller from reaching a
    signing route — the route whose failure would be worst is `l2/finalize`.
    """
    for method, path, body in PRIVATE_ROUTES:
        response = client.request(method, path, json=body)
        assert response.status_code == 401, f"{method} {path} -> {response.status_code}"
        error = error_body(response)
        assert error["code"] == "CS_UNAUTHENTICATED"
        assert error["retryable"] is False
        assert error["userMessage"] == "Please sign in and try again."
        assert response.headers["WWW-Authenticate"] == "Bearer"


def test_AT_M3_11_a_wrong_token_is_rejected(client) -> None:
    """Not just *missing*: wrong, malformed and wrong-scheme tokens are all refused."""
    for header in (
        "Bearer wrong-token",
        "Bearer ",
        "Basic dXNlcjpwYXNz",
        SERVICE_TOKEN,  # the bare token, no scheme
        f"Bearer {SERVICE_TOKEN}x",  # a prefix of the real one
        f"bearer {SERVICE_TOKEN} extra",
    ):
        response = client.post("/v1/l1/issue", json={}, headers={"Authorization": header})
        assert response.status_code == 401, f"{header!r} -> {response.status_code}"


def test_AT_M3_11_the_exact_token_is_accepted(client, auth: dict[str, str]) -> None:
    """The positive control: the comparison is not simply always failing.

    Without this, every 401 assertion above would pass on a service that rejects all tokens.
    """
    assert client.get("/v1/status").status_code == 200
    response = client.post("/v1/keys/agent", json={"agent_id": "agt_x"}, headers=auth)
    assert response.status_code == 200


def test_AT_M3_11_the_scheme_is_case_insensitive_as_rfc_7235_requires(client, auth: dict[str, str]) -> None:
    """`bearer` and `Bearer` are the same scheme. The *token* is still compared exactly."""
    assert (
        client.post(
            "/v1/keys/agent", json={"agent_id": "a"}, headers={"Authorization": f"bearer {SERVICE_TOKEN}"}
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/keys/agent", json={"agent_id": "b"}, headers={"Authorization": "BEARER wrong"}
        ).status_code
        == 401
    )


def test_at_m3_11_the_two_public_routes_need_no_token(client) -> None:
    """Spec §8.3 names exactly two public routes, and they really are open."""
    assert client.get("/v1/jwks").status_code == 200
    # `public/verify` needs a well-formed body, not a token — a *malformed* body is still a 400.
    unauthenticated = client.post("/v1/public/verify", json={})
    assert unauthenticated.status_code == 400
    assert error_body(unauthenticated)["code"] == "CS_VALIDATION"

    # And a valid public request works with no Authorization header at all.
    l1 = client.post(
        "/v1/l1/issue",
        json={
            "user_id": "usr_x",
            "wallet": {"payer_id": "P", "payer_email": "a@b.test", "payment_token_id": "t"},
            "device_public_jwk": {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "B" * 43},
        },
        headers={"Authorization": f"Bearer {SERVICE_TOKEN}"},
    ).json()
    assert (
        client.post("/v1/public/verify", json={"bundle": {"l1": l1["l1"], "l2": l1["l1"]}}).status_code == 200
    )


# ====================================================================================================
# AT-M3.10 — the prepare_id expires after 300 s
# ====================================================================================================


def test_AT_M3_10_prepare_id_expires_after_300_seconds(
    client, auth, builder, device_key, agent_key, clock
) -> None:
    """AT-M3.10 — the `prepare_id` is good for exactly 300 s, then it is gone.

    Time is moved by hand via the injected clock, so the test is instant and exact rather than
    approximate. This matters because a `prepare_id` is a **capability**: it authorises one signature
    over one specific byte string, and an expired capability that still works is a capability nobody
    can revoke.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    signature = device_key.sign(prepared["signing_input"])
    assert prepared["prepare_ttl_seconds"] == 300

    # One second before expiry it still works.
    clock.set(prepared["expires_at"] - 1)
    assert builder.finalize_l2(prepared["prepare_id"], signature).status_code == 200

    # One second after, it is gone.
    clock.set(prepared["expires_at"])
    expired = builder.finalize_l2(prepared["prepare_id"], signature)

    assert expired.status_code == 404, expired.text
    error = error_body(expired)
    assert error["code"] == "CS_NOT_FOUND"
    assert error["details"]["prepare_ttl_seconds"] == 300


def test_AT_M3_10_the_store_actually_drops_the_record(
    client, auth, builder, device_key, agent_key, clock
) -> None:
    """Expiry is enforced by *removal*, not by a timestamp comparison at read time.

    A record that lingers in memory is a record that shows up in a heap dump, and one that is only
    *logically* expired still leaks the `signing_input` to anyone with process access.
    """
    from vi_service.l2 import get_prepare_store

    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    store = get_prepare_store()
    assert store.get(prepared["prepare_id"]) is not None

    clock.set(prepared["expires_at"] + 1)
    assert store.get(prepared["prepare_id"]) is None
    assert len(store) == 0


def test_AT_M3_10_the_ttl_is_configurable_and_the_default_is_300(
    client, auth, builder, device_key, agent_key, monkeypatch
) -> None:
    """`VI_PREPARE_TTL_SECONDS` can shorten it; the default stays at the spec's 300 s."""
    from vi_service import l2 as l2_module

    monkeypatch.setenv("VI_PREPARE_TTL_SECONDS", "30")
    config.reset_settings()
    l2_module.reset_prepare_store()

    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    assert prepared["prepare_ttl_seconds"] == 30

    assert (
        builder.finalize_l2(prepared["prepare_id"], device_key.sign(prepared["signing_input"])).status_code
        == 200
    )

    monkeypatch.setenv("VI_PREPARE_TTL_SECONDS", "not-a-number")
    config.reset_settings()
    with pytest.raises(config.ConfigError, match="must be an integer"):
        config.load_settings()


def test_AT_M3_10_an_unknown_prepare_id_is_not_found(client, auth: dict[str, str]) -> None:
    """A `prepare_id` we never issued is `CS_NOT_FOUND`, and reveals nothing about any real one."""
    response = client.post(
        "/v1/l2/finalize",
        json={"prepare_id": "prep_does_not_exist", "signature_b64url": "A" * 86},
        headers=auth,
    )
    assert response.status_code == 404
    assert error_body(response)["code"] == "CS_NOT_FOUND"


def test_AT_M3_10_finalize_is_repeatable_within_the_window(
    client, auth, builder, device_key, agent_key
) -> None:
    """Within the TTL, finalizing twice returns the same L2.

    The browser retries after a network blip; a one-shot `prepare_id` would force the user through
    the read-back again for no reason. The signature is re-verified every time, so nothing is
    granted that was not granted the first time.
    """
    l1 = builder.issue_l1()
    prepared = builder.prepare_l2(l1["l1"], agent_key, instrument_id=l1["card_id"])
    signature = device_key.sign(prepared["signing_input"])

    first = builder.finalize_l2(prepared["prepare_id"], signature)
    second = builder.finalize_l2(prepared["prepare_id"], signature)

    assert first.status_code == second.status_code == 200
    assert first.json()["l2"] == second.json()["l2"]


# ====================================================================================================
# the rate limit on the two public routes
# ====================================================================================================


def test_public_routes_are_rate_limited_to_30_per_minute(client) -> None:
    """Spec §8.3: 30 req/min/IP on `GET /v1/jwks` and `POST /v1/public/verify`.

    The 31st request is refused with `Retry-After`, and the budget is per-IP so one abusive client
    cannot spend everyone else's.
    """
    for _ in range(30):
        assert client.get("/v1/jwks").status_code == 200

    limited = client.get("/v1/jwks")
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    error = error_body(limited)
    assert error["retryable"] is True
    assert error["details"]["limit"] == 30
    assert error["details"]["window_seconds"] == 60


def test_the_rate_limit_does_not_apply_to_the_private_routes(client, auth: dict[str, str]) -> None:
    """Authenticated service-to-service traffic is not rationed by the public budget.

    `apps/web` calls these in a loop during a checkout; a 30/min ceiling shared with the public
    verifier would break a legitimate purchase.
    """
    for _ in range(35):
        assert client.get("/v1/status").status_code == 200
    for _ in range(35):
        assert client.post("/v1/keys/rotate", json={"role": "ISSUER"}, headers=auth).status_code == 200


def test_the_rate_limit_is_per_ip(client) -> None:
    """One IP exhausting its budget does not affect another."""
    limiter = ratelimit.RateLimiter(limit=2, window_seconds=60)

    assert limiter.check("1.1.1.1")[0] is True
    assert limiter.check("1.1.1.1")[0] is True
    assert limiter.check("1.1.1.1")[0] is False
    assert limiter.check("2.2.2.2")[0] is True


def test_the_rate_limit_window_slides_rather_than_resetting(client) -> None:
    """A fixed window would allow `2 × limit` across a boundary. This one slides instead."""
    limiter = ratelimit.RateLimiter(limit=3, window_seconds=10)

    for t in (0.0, 1.0, 2.0):
        assert limiter.check("ip", now=t)[0] is True
    assert limiter.check("ip", now=3.0)[0] is False

    # At t=11.5 both t=0 and t=1 have aged out, so two slots are free.
    assert limiter.check("ip", now=11.0)[0] is True
    assert limiter.check("ip", now=11.5)[0] is True
    assert limiter.check("ip", now=11.6)[0] is False  # full again

    # Recovery is gradual: each hit frees exactly one slot 10 s after it landed, so the client can
    # never burst again the way a fixed window would allow across a boundary.
    assert limiter.check("ip", now=21.1)[0] is True  # the t=11 hit aged out
    assert limiter.check("ip", now=21.6)[0] is True  # the t=11.5 hit aged out
    assert limiter.check("ip", now=22.0)[0] is True  # the t=11.6 window has no recorded hit to age out
    assert limiter.check("ip", now=22.1)[0] is False  # full again


def test_a_rejected_request_does_not_extend_its_own_window(client) -> None:
    """Hammering must not push the caller's recovery further out."""
    limiter = ratelimit.RateLimiter(limit=1, window_seconds=10)

    assert limiter.check("ip", now=0.0)[0] is True
    assert limiter.check("ip", now=1.0)[0] is False
    assert limiter.check("ip", now=9.9)[0] is False
    # The first hit ages out at t=10, so the next request succeeds.
    assert limiter.check("ip", now=10.5)[0] is True


def test_retry_after_names_when_the_window_frees_up(client) -> None:
    """`Retry-After` must be actionable, not a guess."""
    limiter = ratelimit.RateLimiter(limit=1, window_seconds=60)

    limiter.check("ip", now=0.0)
    allowed, retry_after = limiter.check("ip", now=5.0)
    assert allowed is False
    assert retry_after == 56  # 60s window from t=0, now t=5


def test_client_id_prefers_the_original_forwarded_hop() -> None:
    """`X-Forwarded-For` is read only for its first hop, and only when a proxy set it.

    A forged header would otherwise let one caller mint unlimited budgets by rotating a fake value.
    """
    assert ratelimit.client_id_for("10.0.0.1") == "10.0.0.1"
    assert ratelimit.client_id_for("10.0.0.1", "203.0.113.7, 70.41.3.18") == "203.0.113.7"
    assert ratelimit.client_id_for(None) == "unknown"
    # Some proxies prepend an empty entry; the first *non-empty* hop is still the original client.
    assert ratelimit.client_id_for(None, "  , 203.0.113.7 ") == "203.0.113.7"
    # An all-empty header carries no information, so fall back to the peer.
    assert ratelimit.client_id_for("10.0.0.1", " , ") == "10.0.0.1"


# ====================================================================================================
# the error contract
# ====================================================================================================


def test_every_error_path_produces_exactly_the_core_error_body(client, auth: dict[str, str]) -> None:
    """One shape for every status code, matching `packages/core`'s `toBody()`.

    `error_body()` asserts the shape, so walking four different failure kinds is what proves the
    handlers are uniform rather than four separate look-alikes.
    """
    assert error_body(client.post("/v1/l1/issue", json={}, headers=auth))["code"] == "CS_VALIDATION"
    assert error_body(client.post("/v1/l3/create", json={}, headers=auth))["code"] == "CS_VALIDATION"
    assert (
        error_body(client.post("/v1/keys/rotate", json={"role": "NOPE"}, headers=auth))["code"]
        == "CS_VALIDATION"
    )
    assert (
        error_body(
            client.post("/v1/l2/finalize", json={"prepare_id": "x", "signature_b64url": "A"}, headers=auth)
        )["code"]
        == "CS_NOT_FOUND"
    )
    assert error_body(client.post("/v1/keys/agent", json={"agent_id": "a"}))["code"] == "CS_UNAUTHENTICATED"
    assert error_body(client.get("/v1/no-such-route"))["code"] == "CS_NOT_FOUND"


def test_error_codes_come_only_from_the_core_registry(client, auth: dict[str, str]) -> None:
    """Every code this service can emit exists in `CS_ERROR_CODES`.

    Mirrors `packages/core/src/errors.ts`. A code the TypeScript side has never heard of would be a
    500 in the client, which is the worst possible outcome for an error path.
    """
    from vi_service.errors import _RETRYABLE, _USER_MESSAGES, status_for

    assert set(_USER_MESSAGES) == CS_ERROR_CODES, "every registry code needs buyer-facing copy"
    assert _RETRYABLE <= CS_ERROR_CODES
    assert set(_STATUS_KEYS()) <= CS_ERROR_CODES

    for code in CS_ERROR_CODES:
        assert 100 <= status_for(code) <= 599


def test_user_messages_are_present_for_every_code_the_service_uses() -> None:
    """A code with no copy falls back to a generic sentence — which must never leak `message`."""
    from vi_service.errors import _DEFAULT_USER_MESSAGE, _USER_MESSAGES, cs_error

    for code in ("CS_VALIDATION", "VI_SIGNATURE_MISMATCH", "VI_CONSTRAINT_VIOLATION", "CS_NOT_FOUND"):
        err = cs_error(code, "internal detail that must not reach a buyer")
        assert err.user_message
        assert code not in _USER_MESSAGES or err.user_message != _DEFAULT_USER_MESSAGE
        assert "internal detail" not in err.user_message


def test_details_are_scrubbed_of_anything_that_looks_like_a_secret() -> None:
    """`safe_details` mirrors core's scrub list, plus `api_key` and a `_key` suffix.

    This body goes to a browser. A `details` bag is convenient, and that is exactly how an
    `access_token` ends up in a support screenshot. Being a *stricter superset* than core cannot break
    a client — a hidden key is invisible to a caller.
    """
    from vi_service.errors import cs_error

    err = cs_error(
        "CS_VALIDATION",
        "boom",
        {
            "prepare_id": "prep_1",
            "device_jkt": "abc",
            "access_token": "sk_live_x",
            "api_key": "x",
            "agent_private_key": "x",
            "session_secret": "x",
            "x-api-key": "x",
            "Authorization": "Bearer x",
            "stack": "…",
        },
    )
    body = err.to_body()

    assert set(body["error"]["details"]) == {"prepare_id", "device_jkt"}
    assert "sk_live_x" not in json.dumps(body)


def test_an_empty_details_bag_is_omitted_from_the_body() -> None:
    """Core omits `details` when nothing survives the scrub; so do we, so the shapes match."""
    from vi_service.errors import cs_error

    assert "details" not in cs_error("CS_VALIDATION", "x", {}).to_body()["error"]
    assert "details" not in cs_error("CS_VALIDATION", "x", None).to_body()["error"]
    assert "details" not in cs_error("CS_VALIDATION", "x", {"token": "y"}).to_body()["error"]
    assert "details" in cs_error("CS_VALIDATION", "x", {"a": 1}).to_body()["error"]


def test_an_unhandled_exception_becomes_a_cs_error_without_a_traceback(
    _environment, auth, monkeypatch
) -> None:
    """A bug in a handler is a 500 with a `CsErrorBody` and no internals.

    Reported as `CS_INTERNAL`, matching `packages/core`'s `toCsError` default (D-007). It was
    `CS_VALIDATION`, which told the caller their request was invalid — sending whoever was debugging
    it to look at the wrong thing, and counting every server fault as a user error.

    The absence of the exception text is asserted too: a stack trace in an HTTP body is an
    information leak with a production-only failure mode.

    `raise_server_exceptions=False` because the default `TestClient` re-raises after the handler has
    run, which is a property of the test client rather than of the service. The point here is the
    body that goes on the wire.
    """
    from vi_service import main as main_module

    def boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("SECRET_INTERNAL_DETAIL sqlite:///prod.db password=hunter2")

    # `main` imports the symbol directly, so the patch has to land there.
    monkeypatch.setattr(main_module, "issue_l1", boom)

    with TestClient(_environment, raise_server_exceptions=False) as lenient:
        response = lenient.post(
            "/v1/l1/issue",
            json={
                "user_id": "usr_x",
                "wallet": {"payer_id": "P", "payer_email": "a@b.test", "payment_token_id": "t"},
                "device_public_jwk": {"kty": "EC", "crv": "P-256", "x": "A" * 43, "y": "B" * 43},
            },
            headers=auth,
        )

    assert response.status_code == 500
    error = error_body(response)
    assert error["code"] == "CS_INTERNAL"
    assert "SECRET_INTERNAL_DETAIL" not in response.text
    assert "hunter2" not in response.text
    assert "Traceback" not in response.text
    # Not retryable: a blind retry of a 500 usually reproduces it.
    assert error["retryable"] is False


def test_pydantic_validation_errors_are_converted_not_passed_through(client, auth: dict[str, str]) -> None:
    """FastAPI's own 422 body is `{"detail": [...]}`, which no Countersign client parses.

    Converted to `CS_VALIDATION` with `loc`/`msg`/`type` copied — and *not* pydantic's `input`, which
    would echo the caller's raw value, which on this service can be a token.
    """
    response = client.post(
        "/v1/verify",
        json={"l1": 123, "l2": "x" * 10, "api_key": "sk_live_y"},
        headers=auth,
    )

    assert response.status_code == 400
    assert "detail" not in response.json()
    error = error_body(response)
    assert error["code"] == "CS_VALIDATION"
    assert "sk_live_y" not in response.text
    fields = error["details"]["fields"]
    assert {tuple(f["loc"]) for f in fields} >= {("body", "l1")}
    assert all(set(f) == {"loc", "msg", "type"} for f in fields)


def test_openapi_document_is_served_for_the_schema_drift_test(client) -> None:
    """Spec §8.4 AT-M4.2: WP-04 fails CI if the zod schemas drift from `/openapi.json`.

    So the document has to exist and actually describe the routes, not be an empty shell.
    """
    document = client.get("/openapi.json").json()

    assert document["info"]["title"] == "Countersign vi-service"
    for path in (
        "/v1/l1/issue",
        "/v1/l2/prepare",
        "/v1/l2/finalize",
        "/v1/checkout-jwt",
        "/v1/l3/create",
        "/v1/verify",
        "/v1/public/verify",
        "/v1/jwks",
        "/v1/keys/agent",
        "/v1/keys/rotate",
    ):
        assert path in document["paths"], f"{path} missing from the OpenAPI document"

    l3_schema = document["components"]["schemas"]["L3Payment"]
    assert "amount_minor" in l3_schema["properties"]
    assert l3_schema["properties"]["amount_minor"]["type"] in {"integer", "number"}


def test_the_app_starts_without_a_network_or_a_database(_environment) -> None:
    """The service's whole value proposition is being stateless (spec §8.3).

    A test that constructs the app and exercises a route proves there is nothing to start up and
    nothing to tear down — no DB, no migration, no external call.
    """
    with TestClient(_environment) as c:
        assert c.get("/v1/status").json()["ok"] is True


# ====================================================================================================
# boot-time configuration
# ====================================================================================================


def test_the_process_refuses_to_start_without_a_service_token(monkeypatch) -> None:
    """Spec §6: "The process MUST refuse to start if any required variable is missing."

    Failing at boot is the point — a service that starts and then 401s everything is a service that
    looks healthy to the platform.
    """
    import base64 as b64

    monkeypatch.setenv("VI_KEK", b64.b64encode(bytes(32)).decode())
    monkeypatch.delenv("VI_SERVICE_TOKEN", raising=False)
    config.reset_settings()
    with pytest.raises(config.ConfigError, match="VI_SERVICE_TOKEN"):
        config.load_settings()


@pytest.mark.parametrize(
    ("kek", "expected"),
    [
        ("not-base64!!", "must be base64"),
        ("c2hvcnQ=", "exactly 32 bytes"),  # 5 bytes
        ("", "missing"),
    ],
)
def test_the_process_refuses_a_bad_kek(monkeypatch, kek, expected) -> None:
    """A wrong-length KEK fails at boot, not at the first `POST /v1/keys/agent`."""
    monkeypatch.setenv("VI_SERVICE_TOKEN", SERVICE_TOKEN)
    monkeypatch.setenv("VI_KEK", kek)
    config.reset_settings()
    with pytest.raises(config.ConfigError, match=expected):
        config.load_settings()


def _STATUS_KEYS() -> list[str]:
    from vi_service.errors import _STATUS

    return list(_STATUS)
