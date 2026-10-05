"""Environment configuration for vi-service (spec §6).

Read from ``os.environ`` directly: no ``pydantic-settings`` dependency, because §8.3's
dependency set is pinned and adding one would change the audited supply chain (spec §4).

Two things live here on purpose:

* :class:`Settings` — every ``VI_*`` variable, parsed and validated once.
* :func:`now_sec` / :func:`set_clock` — the service's *only* time source. It is injectable so
  that a test can move time forward without sleeping (AT-M3.10, the 300 s ``prepare_id`` TTL,
  and EC-TIME-3's ``at_time``).

Nothing here imports FastAPI or pydantic, so it can be unit-tested in isolation.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

# --- bounds from the spec ------------------------------------------------------------------------

#: §8.3 `POST /v1/l1/issue`: `ttl_days <= 365`.
L1_TTL_DAYS_MAX = 365
#: §8.3 `POST /v1/l2/prepare`: `ttl_seconds <= 2592000` (30 days).
L2_TTL_SECONDS_MAX = 2_592_000
#: §8.3 `l2/prepare` and `l2/finalize`: the prepare record lives in memory for 300 s.
PREPARE_TTL_SECONDS_DEFAULT = 300
#: §8.3: `GET /v1/jwks` and `POST /v1/public/verify` are 30 requests/minute/IP.
PUBLIC_RATE_LIMIT_DEFAULT = 30
#: How many `X-Forwarded-For` hops to trust. **0 by default**, which means the header is ignored
#: entirely and the budget is billed to the socket address. See `ratelimit.client_id_for`.
TRUSTED_PROXY_HOPS_DEFAULT = 0
#: [B2] the library default; spec §6 `VI_CLOCK_SKEW_SECONDS`.
CLOCK_SKEW_SECONDS_DEFAULT = 300
#: §8.3 `POST /v1/checkout-jwt` price lock. `CHECKOUT_PRICE_LOCK_SECONDS` is 900 (spec §6); this
#: is only the ceiling we will accept from a caller, not the default the Gate uses.
CHECKOUT_TTL_SECONDS_MAX = 86_400
#: §8.3 `POST /v1/l3/create` L3 lifetime. The library *requires* `exp - iat <= 3600` (see
#: `verification/chain.py`, "L3 exp MUST NOT exceed 1 hour from iat"), so 300 s is our default
#: and 3600 s is the hard ceiling.
L3_TTL_SECONDS_MAX = 3_600
L3_TTL_SECONDS_DEFAULT = 300


class ConfigError(RuntimeError):
    """A required variable is missing or malformed. The process must refuse to start (spec §6)."""


class Clock:
    """UTC epoch seconds. The single time source, injectable for tests (spec §8.1 ``Clock``)."""

    def now_sec(self) -> int:
        return int(time.time())


class FixedClock(Clock):
    """A clock that stands still, or that a test advances by hand."""

    def __init__(self, sec: int) -> None:
        self._sec = int(sec)

    def now_sec(self) -> int:
        return self._sec

    def advance(self, seconds: int) -> None:
        self._sec += int(seconds)

    def set(self, sec: int) -> None:
        self._sec = int(sec)


_system_clock = Clock()
_clock: Clock = _system_clock


def now_sec() -> int:
    """UTC epoch seconds. Never ``datetime.now()`` anywhere else in the service."""
    return _clock.now_sec()


def set_clock(clock: Clock | None) -> None:
    """Inject a clock. ``None`` restores the system clock. Tests only."""
    global _clock
    _clock = clock if clock is not None else _system_clock


@dataclass(frozen=True)
class Settings:
    """Every ``VI_*`` variable the service reads (spec §6, ``vi`` column)."""

    service_token: str
    #: base64 of exactly 32 bytes. AES-256-GCM key-encryption key for agent private keys.
    kek_b64: str
    issuer_kid: str
    merchant_kid: str
    clock_skew_seconds: int
    prepare_ttl_seconds: int
    public_rate_limit_per_min: int
    #: Number of `X-Forwarded-For` hops to trust when billing the public rate-limit budget. 0 (the
    #: default) means the header is ignored: the socket address is the only client identity, so a
    #: caller cannot mint fresh budgets by sending a header. Raise it to 1 only behind exactly one
    #: known proxy that *replaces* rather than appends the header.
    trusted_proxy_hops: int
    #: ``iss`` of the L1 issuer credential. The ``vct`` stays the library default
    #: ``https://credentials.mastercard.com/card`` because ``verify_chain`` pins it.
    issuer_url: str
    #: ``iss`` written into L3a/L3b when the caller does not override it.
    agent_iss: str
    app_env: str

    def issuer_kid_for_jwks(self) -> str:
        return self.issuer_kid

    def merchant_kid_for_jwks(self) -> str:
        return self.merchant_kid


def _req(name: str) -> str:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        raise ConfigError(f"Required environment variable {name} is missing (spec §6)")
    return raw.strip()


def _int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value < minimum or value > maximum:
        raise ConfigError(f"{name} must be in [{minimum}, {maximum}], got {value}")
    return value


def load_settings() -> Settings:
    """Parse and validate the environment. Raises :class:`ConfigError` if the process may not run."""
    kek = _req("VI_KEK")
    # The KEK is a base64 32-byte AES-256 key. Validate the shape here so a typo fails at boot
    # rather than at the first `POST /v1/keys/agent`.
    import base64

    try:
        decoded = base64.b64decode(kek, validate=True)
    except Exception as exc:  # noqa: BLE001 - any binascii/base64 failure is the same story
        raise ConfigError("VI_KEK must be base64") from exc
    if len(decoded) != 32:
        raise ConfigError(f"VI_KEK must decode to exactly 32 bytes (AES-256), got {len(decoded)}")

    return Settings(
        service_token=_req("VI_SERVICE_TOKEN"),
        kek_b64=kek,
        issuer_kid=os.environ.get("VI_ISSUER_KID", "issuer-key-1").strip() or "issuer-key-1",
        merchant_kid=os.environ.get("VI_MERCHANT_KID", "merchant-key-1").strip() or "merchant-key-1",
        clock_skew_seconds=_int(
            "VI_CLOCK_SKEW_SECONDS", CLOCK_SKEW_SECONDS_DEFAULT, minimum=0, maximum=86_400
        ),
        prepare_ttl_seconds=_int(
            "VI_PREPARE_TTL_SECONDS", PREPARE_TTL_SECONDS_DEFAULT, minimum=1, maximum=3_600
        ),
        public_rate_limit_per_min=_int(
            "VI_PUBLIC_RATE_LIMIT_PER_MIN", PUBLIC_RATE_LIMIT_DEFAULT, minimum=1, maximum=10_000
        ),
        trusted_proxy_hops=_int("VI_TRUSTED_PROXY_HOPS", TRUSTED_PROXY_HOPS_DEFAULT, minimum=0, maximum=8),
        issuer_url=os.environ.get("VI_ISSUER_URL", "https://www.mastercard.com").strip(),
        agent_iss=os.environ.get("VI_AGENT_ISS", "https://agent.countersign.example").strip(),
        app_env=os.environ.get("APP_ENV", "local").strip() or "local",
    )


_settings: Settings | None = None


def get_settings() -> Settings:
    """The process-wide settings, parsed on first use."""
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings


def reset_settings() -> None:
    """Drop the cached settings so the next `get_settings()` re-reads the environment. Tests only."""
    global _settings
    _settings = None
