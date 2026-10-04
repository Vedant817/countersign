"""30 requests/minute per IP for the two public routes (spec §8.3).

Which routes: `GET /v1/jwks` and `POST /v1/public/verify`, and nothing else. They are the only
routes a browser on the public internet can reach, and they are exactly the two that let an
outsider spend CPU on ES256 verification, so they get the budget.

Why in-process: vi-service runs as a single uvicorn process on Render's private network (spec
D20). A shared Redis limiter would be a new dependency for a per-instance budget, and §8.3 pins the
dependency set. If the service is ever scaled past one instance this becomes per-instance rather
than per-deployment, which is weaker but not wrong.

The error code: `CS_ERROR_CODES` has no rate-limit code and spec §8.0 rule 3 says every code comes
from that registry. `PP_RATE_LIMITED` is the wrong prefix — it means *PayPal* is throttling us, and
its buyer-facing copy says exactly that. So the budget is reported as `CS_CONFLICT` with HTTP 429,
`retryable: true` and an explicit `Retry-After`: the closest honest fit in a closed registry.
Flagged for a registry addition.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

from . import errors

DEFAULT_LIMIT = 30
DEFAULT_WINDOW_SECONDS = 60


@dataclass
class RateLimiter:
    """A sliding window of hit timestamps per client id.

    Sliding rather than fixed: a fixed window lets one caller send `limit` requests at t=0.1 s and
    `limit` more at t=59.9 s. For a crypto endpoint that is 60x the intended ceiling.
    """

    limit: int = DEFAULT_LIMIT
    window_seconds: int = DEFAULT_WINDOW_SECONDS
    _hits: dict[str, deque[float]] = field(default_factory=dict)

    def check(self, client_id: str, *, now: float | None = None) -> tuple[bool, int]:
        """Record a hit; return `(allowed, retry_after_seconds)`.

        A rejected request is **not** recorded, so hammering does not push the caller's own window
        further out.
        """
        at = time.monotonic() if now is None else now
        bucket = self._hits.setdefault(client_id, deque())
        cutoff = at - self.window_seconds
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()
        if len(bucket) >= self.limit:
            retry_after = max(1, int(bucket[0] + self.window_seconds - at) + 1)
            return False, retry_after
        bucket.append(at)
        return True, 0

    def reset(self) -> None:
        self._hits.clear()

    def tracked_clients(self) -> int:
        return len(self._hits)


_limiter: RateLimiter | None = None


def get_limiter() -> RateLimiter:
    """The process-wide limiter, sized from `VI_PUBLIC_RATE_LIMIT_PER_MIN` (default 30)."""
    global _limiter
    if _limiter is None:
        from .config import get_settings

        _limiter = RateLimiter(limit=get_settings().public_rate_limit_per_min)
    return _limiter


def reset_limiter() -> None:
    global _limiter
    _limiter = None


def client_id_for(host: str | None, forwarded_for: str | None = None) -> str:
    """Which IP to bill the request to.

    `X-Forwarded-For` is consulted only when vi-service sits behind a proxy that sets it, and only its
    **first** hop — the original client. A forged header would otherwise let one caller mint unlimited
    budgets by rotating a fake value.

    The first *non-empty* hop, because some proxies prepend an empty entry; an empty first hop carries
    no information and falling through to the next one still gives the original client.
    """
    if forwarded_for:
        for hop in forwarded_for.split(","):
            candidate = hop.strip()
            if candidate:
                return candidate
    return host or "unknown"


def enforce(client_id: str, *, limiter: RateLimiter | None = None) -> None:
    """Raise 429 when the client is over budget. The only call the public routes make."""
    limiter = limiter or get_limiter()
    allowed, retry_after = limiter.check(client_id)
    if not allowed:
        raise errors.http_error(
            # `CS_RATE_LIMITED`, not `CS_CONFLICT` (docs/DECISIONS.md D-007). This used to borrow
            # CS_CONFLICT because the registry had no rate-limit code, which meant the error said
            # "that conflicts with something we already saved, refresh and try again" — advice that
            # is actively wrong when the cause is that we asked for too many things too quickly. A
            # code that says the wrong thing sends a developer to debug the wrong problem.
            "CS_RATE_LIMITED",
            f"Rate limit exceeded: {limiter.limit} requests per {limiter.window_seconds}s per IP. "
            f"Try again in {retry_after}s.",
            {
                "limit": limiter.limit,
                "window_seconds": limiter.window_seconds,
                "retry_after_seconds": retry_after,
            },
            retryable=True,
            status_code=429,
            headers={"Retry-After": str(retry_after)},
        )
