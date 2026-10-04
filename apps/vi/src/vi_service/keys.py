"""The key registry: issuer, merchant, agent keys, JWKS and rotation (spec §3.1, §8.3, EC-KEY-*).

vi-service is "stateless except for its keys" (spec §8.3), so this module is the whole of its
state. Three roles:

==========  ================================================================================
ISSUER      In memory from ``VI_ISSUER_KID``. Signs L1. Its public half is in ``GET /v1/jwks``.
MERCHANT    In memory from ``VI_MERCHANT_KID``. Signs the price-locked checkout JWT.
AGENT       **AES-256-GCM encrypted** under ``VI_KEK``. `apps/web` stores only the ciphertext in
            ``agents.enc_private_key`` (spec D5), so the raw private key never leaves here.
==========  ================================================================================

Rotation **retires**, never deletes. A retired key stays resolvable by ``kid`` for verification and
stays in JWKS with ``status: "RETIRED"``, so a dispute filed months after the rotation still
verifies (spec EC-KEY-2, EC-KEY-3). Verification must be *more* permissive than issuance; that
asymmetry is the whole point.

The service does not persist anything. Agent private keys are re-created from the KEK on demand,
which is why losing the KEK invalidates agent keys but not historical evidence: the public halves
stay in JWKS (EC-KEY-4).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from verifiable_intent.crypto.sd_jwt import SdJwt, verify_sd_jwt_signature
from verifiable_intent.crypto.signing import (
    generate_es256_key,
    jwk_to_private_key,
    jwk_to_public_key,
    private_key_to_jwk,
    public_key_to_jwk,
)

from . import errors
from .config import Settings, get_settings, now_sec

KeyRole = Literal["ISSUER", "MERCHANT", "AGENT"]
KeyStatus = Literal["ACTIVE", "RETIRED", "COMPROMISED"]

#: Roles `POST /v1/keys/rotate` accepts. AGENT is per-agent and rotates with the agent, not here.
ROTATABLE_ROLES: tuple[str, ...] = ("ISSUER", "MERCHANT")

_AAD_CONTEXT = b"countersign/vi/agent-key/v1"
_NONCE_BYTES = 12  # AES-GCM's recommended 96-bit nonce


def b64u_encode(data: bytes) -> str:
    """base64url without padding. One implementation, used everywhere in the service."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(value: str) -> bytes:
    """base64url decode, tolerating the padding the spec does and does not require."""
    padding = -len(value) % 4
    return base64.urlsafe_b64decode(value + "=" * padding)


def rfc7638_thumbprint(jwk: dict[str, Any]) -> str:
    """RFC 7638 JWK thumbprint, base64url — the `devices.jkt` column (spec §7.2).

    For a P-256 EC key the required members are exactly `{"crv","kty","x","y"}`, ordered
    lexicographically, serialised with no whitespace, then SHA-256, then base64url. Same bytes as
    WebAuthn's `authenticatorData` key thumbprint, so `devices.jkt` means the same thing on both
    sides of the wire.

    Raises `ValueError` on a JWK that is not a P-256 public key. This is a shape check on data that
    should already be valid, so it is a plain programming-error signal rather than a `CsError`; every
    route reaches it with a JWK that has already been validated.
    """
    for member in ("crv", "kty", "x", "y"):
        if not isinstance(jwk.get(member), str) or not jwk[member]:
            raise ValueError(f"a P-256 public JWK needs a string {member!r}; got keys {sorted(jwk)}")
    canonical = json.dumps(
        {m: jwk[m] for m in ("crv", "kty", "x", "y")}, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return b64u_encode(hashlib.sha256(canonical).digest())


# --- AES-256-GCM key encryption ------------------------------------------------------------------


def _kek(settings: Settings) -> bytes:
    return base64.b64decode(settings.kek_b64, validate=True)


def encrypt_private_key(kek: bytes, private_jwk: dict[str, Any], *, aad: str) -> bytes:
    """AES-256-GCM. Layout: ``nonce(12) || ciphertext || tag(16)``.

    `aad` binds the ciphertext to the row it belongs to (`agent_id`/`kid`). Without it, a
    ciphertext lifted out of one `agents` row would decrypt cleanly in another — the KEK would
    have authenticated the bytes but not their identity.
    """
    nonce = os.urandom(_NONCE_BYTES)
    raw = json.dumps(private_jwk, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ct = AESGCM(kek).encrypt(nonce, raw, _AAD_CONTEXT + b"|" + aad.encode("utf-8"))
    return nonce + ct


def decrypt_private_key(kek: bytes, blob: bytes, *, aad: str) -> dict[str, Any]:
    """Inverse of :func:`encrypt_private_key`. Raises `ValueError` on any mismatch."""
    if len(blob) < _NONCE_BYTES + 16:
        raise ValueError("encrypted key blob is too short")
    nonce, ct = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
    try:
        raw = AESGCM(kek).decrypt(nonce, ct, _AAD_CONTEXT + b"|" + aad.encode("utf-8"))
    except InvalidTag as exc:
        raise ValueError("agent private key failed authentication (wrong KEK, or row mismatch)") from exc
    return json.loads(raw.decode("utf-8"))


# --- registry -------------------------------------------------------------------------------------


@dataclass
class KeyEntry:
    kid: str
    role: KeyRole
    public_jwk: dict[str, Any]
    status: KeyStatus = "ACTIVE"
    not_before: int = 0
    #: Present only for ISSUER and MERCHANT. Agent private keys exist only as ciphertext.
    private_key: ec.EllipticCurvePrivateKey | None = field(default=None, repr=False)
    #: Subject the key belongs to (`agent_id`), for AGENT keys.
    owner_id: str | None = None
    retired_at: int | None = None

    def jwks_entry(self) -> dict[str, Any]:
        """One JWKS key. `status` is ours, not RFC 7517 — it is how EC-KEY-2/3 stay checkable."""
        entry: dict[str, Any] = {
            "kid": self.kid,
            "kty": self.public_jwk.get("kty", "EC"),
            "crv": self.public_jwk.get("crv", "P-256"),
            "x": self.public_jwk.get("x", ""),
            "y": self.public_jwk.get("y", ""),
            "alg": "ES256",
            "use": "sig",
            "role": self.role,
            "status": self.status,
        }
        if self.owner_id:
            entry["owner_id"] = self.owner_id
        if self.not_before:
            entry["not_before"] = self.not_before
        if self.retired_at is not None:
            entry["retired_at"] = self.retired_at
        return entry


class KeyStore:
    """In-memory key registry, rebuilt from the environment on first use."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._entries: dict[str, KeyEntry] = {}
        self._current: dict[str, str] = {}
        self._boot()

    # -- lifecycle ---------------------------------------------------------------------------------

    def _boot(self) -> None:
        """Mint the ISSUER and MERCHANT keys. Ephemeral by design (spec §3.1: 'in memory')."""
        for role, kid in (("ISSUER", self._settings.issuer_kid), ("MERCHANT", self._settings.merchant_kid)):
            key = generate_es256_key()
            self._entries[kid] = KeyEntry(
                kid=kid,
                role=role,  # type: ignore[arg-type]
                public_jwk=public_key_to_jwk(key),
                private_key=key,
                status="ACTIVE",
                not_before=now_sec(),
            )
            self._current[role] = kid

    # -- reads ------------------------------------------------------------------------------------

    def get(self, kid: str) -> KeyEntry | None:
        return self._entries.get(kid)

    def current_kid(self, role: str) -> str:
        return self._current[role]

    def signing_key(self, role: str) -> ec.EllipticCurvePrivateKey:
        """The private half for ISSUER or MERCHANT. Raises if the registry is somehow empty."""
        entry = self._entries[self._current[role]]
        if entry.private_key is None:  # pragma: no cover - never true for these two roles
            raise errors.http_error("CS_VALIDATION", f"No private key for role {role}")
        return entry.private_key

    def public_key(self, role: str) -> ec.EllipticCurvePublicKey:
        """The current public key for a role, for `verify_chain(issuer_public_key=…)`.

        Correct only for a *live* chain. For a chain whose L1 was signed by a since-retired key,
        use :meth:`public_key_by_kid` — see EC-KEY-2.
        """
        return self.signing_key(role).public_key()

    def public_key_by_kid(self, kid: str) -> ec.EllipticCurvePublicKey | None:
        """Public key for any `kid`, ACTIVE **or RETIRED**. This is EC-KEY-2 and EC-KEY-3.

        A `COMPROMISED` key is deliberately *not* resolvable: after a compromise the key must stop
        verifying even though its evidence is still retained for the record.
        """
        entry = self._entries.get(kid)
        if entry is None or entry.status == "COMPROMISED":
            return None
        if entry.private_key is not None:
            return entry.private_key.public_key()
        # Agent keys hold no private half; reconstruct the public key from the stored JWK.
        return jwk_to_public_key(entry.public_jwk)

    def issuer_kid_for(self, l1: SdJwt) -> str | None:
        kid = l1.header.get("kid")
        return kid if isinstance(kid, str) else None

    def verify_with_registry(self, sd_jwt: SdJwt, role: KeyRole) -> tuple[bool, str | None]:
        """Verify an SD-JWT against whichever key its own `kid` names, retired keys included.

        This is the single verification path in the service. It never falls back to "the current
        key": the token names the key it was signed with, and a retired key keeps verifying.
        """
        kid = sd_jwt.header.get("kid")
        if not isinstance(kid, str) or not kid:
            return False, "token header has no kid, so no key can be resolved"
        entry = self._entries.get(kid)
        if entry is None:
            return False, f"unknown key id: {kid}"
        if entry.status == "COMPROMISED":
            return False, f"key {kid} is marked COMPROMISED and no longer verifies"
        if entry.role != role:
            return False, f"key {kid} is a {entry.role} key, expected {role}"
        pub = self.public_key_by_kid(kid)
        if pub is None:  # pragma: no cover - unreachable given the checks above
            return False, f"key {kid} has no usable public half"
        return verify_sd_jwt_signature(sd_jwt, pub), None

    # -- writes -----------------------------------------------------------------------------------

    def mint_agent_key(self, agent_id: str) -> tuple[KeyEntry, bytes]:
        """Mint a P-256 key for one agent and return `(entry, encrypted private JWK)`.

        The plaintext private JWK leaves this function only as ciphertext. Per-agent keys are what
        make an L3 attributable: `verify_chain` resolves the agent key from the L2's `cnf.jwk`, so
        an L3 signed by anyone else fails.
        """
        key = generate_es256_key()
        private_jwk = private_key_to_jwk(key)
        kid = f"agt_{uuid.uuid4().hex[:16]}"
        entry = KeyEntry(
            kid=kid,
            role="AGENT",
            public_jwk=public_key_to_jwk(key),
            status="ACTIVE",
            not_before=now_sec(),
            owner_id=agent_id,
        )
        self._entries[kid] = entry
        blob = encrypt_private_key(_kek(self._settings), private_jwk, aad=_agent_aad(agent_id, kid))
        return entry, blob

    def require_agent_entry(self, agent_kid: str) -> KeyEntry:
        """The registry entry for an AGENT `kid`, or `CS_NOT_FOUND` / `CS_VALIDATION`.

        Split out from :meth:`load_agent_private_key` so a caller can reject a bad `kid` with a cheap
        lookup, before any decryption happens.
        """
        entry = self._entries.get(agent_kid)
        if entry is None:
            raise errors.http_error(
                "CS_NOT_FOUND",
                f"Unknown agent kid {agent_kid!r}. Mint it with POST /v1/keys/agent first.",
                {"agent_kid": agent_kid},
            )
        if entry.role != "AGENT":
            raise errors.http_error(
                "CS_VALIDATION", f"kid {agent_kid!r} is a {entry.role} key, not an AGENT key"
            )
        return entry

    def load_agent_private_key(
        self, agent_kid: str, enc_private_key_b64: str, agent_id: str | None
    ) -> ec.EllipticCurvePrivateKey:
        """Decrypt an agent private key and check it is the key the registry knows for that `kid`.

        The `kid` check is the point: a caller cannot present some *other* agent's ciphertext under
        this `kid` and get it signed.
        """
        entry = self.require_agent_entry(agent_kid)
        owner = agent_id or entry.owner_id or ""
        try:
            blob = base64.b64decode(enc_private_key_b64, validate=True)
            private_jwk = decrypt_private_key(_kek(self._settings), blob, aad=_agent_aad(owner, agent_kid))
        except Exception as exc:  # noqa: BLE001 - any failure here is one CS_VALIDATION
            raise errors.http_error(
                "CS_VALIDATION",
                f"Could not decrypt the agent private key for kid {agent_kid!r}: {exc}",
                {"agent_kid": agent_kid},
            ) from exc
        decrypted_public = {member: private_jwk.get(member) for member in ("crv", "kty", "x", "y")}
        if decrypted_public["x"] != entry.public_jwk["x"] or decrypted_public["y"] != entry.public_jwk["y"]:
            raise errors.http_error(
                "CS_VALIDATION",
                f"The decrypted private key for kid {agent_kid!r} does not match its registered public key",
                {"agent_kid": agent_kid},
            )
        return jwk_to_private_key(private_jwk)

    def rotate(self, role: str) -> KeyEntry:
        """Retire the current key for `role` and mint a new one. Returns the new entry.

        The retired entry keeps its public key, so anything it signed still verifies (EC-KEY-2,
        EC-KEY-3). Nothing is deleted, ever.
        """
        if role not in ROTATABLE_ROLES:
            raise errors.http_error(
                "CS_VALIDATION",
                f"role must be one of {list(ROTATABLE_ROLES)}, got {role!r}",
                {"role": role},
            )
        old_kid = self._current[role]
        old = self._entries[old_kid]
        old.status = "RETIRED"
        old.retired_at = now_sec()

        new_kid = f"{role.lower()}-{uuid.uuid4().hex[:12]}"
        key = generate_es256_key()
        entry = KeyEntry(
            kid=new_kid,
            role=role,  # type: ignore[arg-type]
            public_jwk=public_key_to_jwk(key),
            private_key=key,
            status="ACTIVE",
            not_before=now_sec(),
        )
        self._entries[new_kid] = entry
        self._current[role] = new_kid
        return entry

    def jwks(self) -> dict[str, Any]:
        """`GET /v1/jwks`. Every key we hold, ACTIVE and RETIRED, each with a `status` (AT-M3.9)."""
        entries = sorted(
            self._entries.values(),
            key=lambda e: (e.role != "ISSUER", e.role != "MERCHANT", e.role != "AGENT", e.kid),
        )
        return {"keys": [e.jwks_entry() for e in entries]}


def _agent_aad(agent_id: str, kid: str) -> str:
    return f"{agent_id}|{kid}"


_store: KeyStore | None = None
_store_settings: Settings | None = None


def get_keystore() -> KeyStore:
    """The process-wide registry. Rebuilt automatically if the settings are reset (tests)."""
    global _store, _store_settings
    settings = get_settings()
    if _store is None or _store_settings is not settings:
        _store = KeyStore(settings)
        _store_settings = settings
    return _store


def reset_keystore() -> None:
    """Forget every key. Tests only — in production the process holds these for its lifetime."""
    global _store, _store_settings
    _store = None
    _store_settings = None


__all__ = [
    "KeyEntry",
    "KeyRole",
    "KeyStatus",
    "KeyStore",
    "ROTATABLE_ROLES",
    "b64u_decode",
    "b64u_encode",
    "decrypt_private_key",
    "encrypt_private_key",
    "get_keystore",
    "reset_keystore",
    "rfc7638_thumbprint",
]
