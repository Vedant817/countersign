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


def client_id_for(
    host: str | None,
    forwarded_for: str | None = None,
    *,
    trusted_hops: int = 0,
) -> str:
    """Which IP to bill the request to.

    **`X-Forwarded-For` is ignored unless `VI_TRUSTED_PROXY_HOPS` says how many hops to trust, and
    the default is zero.** With the default, `host` — the socket address — is the only client
    identity, so no header can change which budget a request lands in.

    Why the default is zero rather than one. `X-Forwarded-For` is a plain, unauthenticated string
    that any client can set. Hop 1 is only the real client if the thing that wrote it is a proxy we
    control and we know how many proxies sit in front of us. Trusting hop 1 unconditionally was
    exactly that assumption made without the evidence: a caller who controls the leftmost value got
    a fresh 30/min budget per request, so §8.3's budget was per-*string* and a caller could mint
    unlimited ES256 verification CPU on the trust root. Measured before the fix: 35 requests, 35
    different first hops, 35 × 200.

    What `trusted_hops=N` asserts: "the **last N** entries of this header were written by N proxies I
    control, so the entry immediately before them is the client and every earlier entry is
    caller-supplied." That is the strongest claim hop arithmetic can support, and it is the one the
    default of 0 declines to make.

    Two honest limitations, neither of which this function pretends to solve:

    * If the header carries **N or fewer** entries, it does not contain an entry we can attribute to
      the client — everything in it is either ours or the caller's, and the two are indistinguishable.
      So the socket address is used. Behind a proxy that *replaces* the header (emitting a single
      client IP), that means every caller shares one budget: a real availability cost, chosen over a
      spoofable one. The remedy is an edge rate limit that understands the topology, or a proxy
      configured to append so hop `N+1` exists.
    * Whether a proxy replaces or appends is a property of the proxy, not of the header, and no
      arrangement of hop indexing can detect it. This function does not claim otherwise.

    Empty hops are skipped, because some proxies emit a leading empty entry; an empty hop carries no
    information.
    """
    if trusted_hops > 0 and forwarded_for:
        hops = [hop.strip() for hop in forwarded_for.split(",") if hop.strip()]
        if len(hops) > trusted_hops:
            return hops[-(trusted_hops + 1)]
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
