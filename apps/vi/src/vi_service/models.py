"""Every pydantic request and response model (spec §8.3).

Two rules dominate this file.

**Money is integer minor units plus a currency code. Never a float, anywhere** (spec §0, §8.0
rule 9, EC-FX-6). `MinorAmount` is `int` in *strict* mode, so `"130.00"`, `130.0` and `True` are
all rejected by pydantic before a handler ever runs. A float that slipped through here would be a
rounding bug in a payment, so the type refuses to be built at all.

**Amounts never leave without their currency.** `MoneyAmount` is the pair. `MinorAmount` on its
own is only allowed where the currency arrives as a sibling field with a documented invariant
(`shipping_minor`/`tax_minor` next to `currency`).

The constraint models mirror the eight registered `verifiable_intent/models/constraints.py`
`to_dict()` shapes exactly, field for field, because WP-08's zod schemas are tested against the
fixture `tests/test_constraints_fixture.py` writes and those field names are read off that file
([B3]). Unknown types are rejected here, at the edge — spec §8.8 says "exactly the 8 registered
types" and §8.5 says every compiled constraint is re-validated by `l2/prepare`.
"""

from __future__ import annotations

import re
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
    model_validator,
)
from verifiable_intent.models.constraints import (
    AgentRecurrenceConstraint,
    AllowedMerchantConstraint,
    AllowedPayeeConstraint,
    CheckoutLineItemsConstraint,
    PaymentAmountConstraint,
    PaymentBudgetConstraint,
    PaymentRecurrenceConstraint,
    ReferenceConstraint,
)

from . import errors
from .config import (
    CHECKOUT_TTL_SECONDS_MAX,
    L1_TTL_DAYS_MAX,
    L2_TTL_SECONDS_MAX,
    L3_TTL_SECONDS_DEFAULT,
    L3_TTL_SECONDS_MAX,
)
from .keys import b64u_decode

# --- primitives -----------------------------------------------------------------------------------

Currency = Literal["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD"]

#: ISO 20022 frequency codes, exactly as `constraints.py` documents them.
RecurrenceFrequency = Literal[
    "INDA", "DAIL", "WEEK", "TWOK", "TWMN", "MNTH", "TOMN", "QUTR", "FOMN", "SEMI", "YEAR", "TYEA"
]

_B64URL = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _minor_before(value: Any, label: str) -> Any:  # noqa: ANN401 - pre-validator, sees raw JSON
    """Reject anything that is not already an integer, with an error a human can act on.

    `strict=True` alone would reject these too, but with a generic message. The explicit cases
    exist because the two mistakes people actually make are `"130.00"` (a string that *looks*
    like money) and `130.0` (a float from a JSON producer that lost its type). For an amount,
    silently coercing either one is a rounding bug.
    """
    if isinstance(value, bool):
        raise ValueError(f"{label} must be an integer number of minor units, not a boolean")
    if isinstance(value, float):
        raise ValueError(
            f"{label} must be integer minor units (13000 means $130.00), not the float {value!r}. "
            "Money is never a float in this service (spec §0, EC-FX-6)"
        )
    if isinstance(value, str):
        raise ValueError(
            f"{label} must be an integer, not the string {value!r}. Send minor units as a JSON "
            "number (13000), not a formatted amount"
        )
    return value


def MinorAmount(label: str, description: str) -> Any:  # noqa: ANN401 - builds an Annotated alias
    """Integer minor units. Strict: a float or a numeric string is a validation error, not a coercion."""
    return Annotated[
        int,
        BeforeValidator(lambda v, _l=label: _minor_before(v, _l)),
        Field(strict=True, ge=0, description=description),
    ]


def NonEmptyStr(description: str, *, max_length: int = 2048) -> Any:  # noqa: ANN401 - Annotated alias
    """A non-empty string with a bounded length.

    The bound matters on every field that ends up inside a signed credential: an unbounded
    `prompt_summary` or `aud` is unbounded bytes for a verifier to parse.
    """
    return Annotated[str, Field(min_length=1, max_length=max_length, description=description)]


def B64Url(description: str) -> Any:  # noqa: ANN401 - builds an Annotated alias
    """base64url, unpadded. The encoding `hash_bytes` and every signature in this service use."""
    return Annotated[str, Field(pattern=_B64URL, description=description)]


class StrictModel(BaseModel):
    """Reject unknown request fields. A typo'd constraint key must not be silently dropped."""

    model_config = ConfigDict(extra="forbid")


class MoneyAmount(BaseModel):
    """Integer minor units plus an ISO-4217 code. The only way an amount travels in this service."""

    model_config = ConfigDict(extra="forbid")

    minor: MinorAmount("minor", "Integer minor units. 13000 == $130.00 for USD, 13000 == ¥13,000 for JPY.")
    currency: Currency


# --- key material ---------------------------------------------------------------------------------


class PublicJwk(BaseModel):
    """A P-256 public JWK. Private members are refused outright."""

    model_config = ConfigDict(extra="allow")

    kty: Literal["EC"]
    crv: Literal["P-256"]
    x: NonEmptyStr("base64url of the public x coordinate", max_length=64)
    y: NonEmptyStr("base64url of the public y coordinate", max_length=64)

    @field_validator("x", "y")
    @classmethod
    def _coord_length(cls, value: str) -> str:
        raw = b64u_decode(value)
        if len(raw) != 32:
            raise ValueError(f"P-256 coordinates are 32 bytes, got {len(raw)}")
        return value

    @model_validator(mode="after")
    def _no_private_half(self) -> PublicJwk:
        if "d" in self.model_extra:
            raise ValueError(
                "device_public_jwk must be a PUBLIC key; remove the private 'd' member. The browser's "
                "device key is non-extractable (spec §3.1) and vi-service must never see it"
            )
        return self

    def as_dict(self) -> dict[str, Any]:
        """The JWK as the library wants it. `kid` is dropped; `cnf.jwk` gets it from `cnf_kid`."""
        data = self.model_dump()
        data.pop("kid", None)
        return data


# --- the eight constraint types (spec §8.8 / [B3]) -------------------------------------------------


class MerchantRef(BaseModel):
    """One merchant/payee entry. Inner shapes are copied from `examples/autonomous_flow.py`, not invented."""

    model_config = ConfigDict(extra="allow")

    id: NonEmptyStr("Stable merchant id, e.g. the seeded `products`-side merchant id", max_length=128)
    name: NonEmptyStr("Display name", max_length=256)
    website: NonEmptyStr(
        "Merchant URL; also the `payee.website` the library requires on L3a", max_length=2048
    )


class AcceptableItem(BaseModel):
    """One acceptable SKU inside a `line_items` constraint."""

    model_config = ConfigDict(extra="allow")

    id: NonEmptyStr("SKU", max_length=128)
    title: NonEmptyStr(
        "Product title. The library rejects an `acceptable_items` entry without one.", max_length=512
    )


class LineItemRequirement(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: NonEmptyStr("Line-item requirement id", max_length=128)
    acceptable_items: Annotated[
        list[AcceptableItem],
        Field(
            min_length=1,
            description=(
                "At least one acceptable product. An empty list is a wildcard in the "
                "library; we refuse it here so a wildcard cannot be created by accident."
            ),
        ),
    ]
    quantity: Annotated[
        int, Field(strict=True, gt=0, description="Upper bound on total quantity for this requirement.")
    ]


class _ConstraintBase(StrictModel):
    def to_library_dict(self) -> dict[str, Any]:  # pragma: no cover - overridden
        raise NotImplementedError


class AllowedMerchantsConstraint(_ConstraintBase):
    type: Literal["mandate.checkout.allowed_merchants"]
    allowed: Annotated[list[MerchantRef], Field(min_length=1)]

    def to_library_dict(self) -> dict[str, Any]:
        return AllowedMerchantConstraint(allowed=[m.model_dump() for m in self.allowed]).to_dict()


class LineItemsConstraint(_ConstraintBase):
    type: Literal["mandate.checkout.line_items"]
    items: Annotated[list[LineItemRequirement], Field(min_length=1)]
    match_mode: Literal["minimum", "exact"] = "minimum"

    def to_library_dict(self) -> dict[str, Any]:
        return CheckoutLineItemsConstraint(
            items=[i.model_dump() for i in self.items], match_mode=self.match_mode
        ).to_dict()


class AllowedPayeesConstraint(_ConstraintBase):
    type: Literal["mandate.payment.allowed_payees"]
    allowed: Annotated[list[MerchantRef], Field(min_length=1)]

    def to_library_dict(self) -> dict[str, Any]:
        return AllowedPayeeConstraint(allowed=[m.model_dump() for m in self.allowed]).to_dict()


class AmountRangeConstraint(_ConstraintBase):
    type: Literal["mandate.payment.amount_range"]
    currency: Currency
    min: MinorAmount("amount_range.min", "Lower bound in minor units") | None = None
    max: MinorAmount("amount_range.max", "Upper bound in minor units") | None = None

    @model_validator(mode="after")
    def _ordered(self) -> AmountRangeConstraint:
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError(f"amount_range min ({self.min}) must not exceed max ({self.max})")
        return self

    def to_library_dict(self) -> dict[str, Any]:
        return PaymentAmountConstraint(currency=self.currency, min=self.min, max=self.max).to_dict()


class BudgetConstraint(_ConstraintBase):
    """Cumulative spend cap. **Not evaluated by the library** — the Countersign Gate enforces it
    (spec D19). We surface it as *skipped* so the Gate knows what it still owes (spec §8.8 [B3])."""

    type: Literal["mandate.payment.budget"]
    currency: Currency
    max: Annotated[
        int,
        Field(
            strict=True,
            gt=0,
            description=(
                "Cumulative cap in minor units. Must be > 0; the library raises ValueError "
                "otherwise, so we reject it earlier and cleaner."
            ),
        ),
    ]
    min: Annotated[int, Field(strict=True, gt=0)] | None = None

    def to_library_dict(self) -> dict[str, Any]:
        return PaymentBudgetConstraint(currency=self.currency, max=self.max, min=self.min).to_dict()


class RecurrenceConstraint(_ConstraintBase):
    """Subscription terms. Not evaluated by the library; the Gate owns it (spec D19)."""

    type: Literal["mandate.payment.recurrence"]
    frequency: RecurrenceFrequency
    start_date: Annotated[str, Field(pattern=_ISO_DATE, description="ISO 8601 date, YYYY-MM-DD")]
    end_date: Annotated[str, Field(pattern=_ISO_DATE)] | None = None
    number: Annotated[int, Field(strict=True, gt=0)] | None = None

    def to_library_dict(self) -> dict[str, Any]:
        return PaymentRecurrenceConstraint(
            frequency=self.frequency,
            start_date=self.start_date,
            end_date=self.end_date,
            number=self.number,
        ).to_dict()


class AgentRecurrenceConstraintModel(_ConstraintBase):
    """Agent-managed recurring terms. `end_date` is REQUIRED by the library. Not evaluated by it."""

    type: Literal["mandate.payment.agent_recurrence"]
    frequency: RecurrenceFrequency
    start_date: Annotated[str, Field(pattern=_ISO_DATE)]
    end_date: Annotated[
        str, Field(pattern=_ISO_DATE, description="Required by the library for agent_recurrence")
    ]
    max_occurrences: Annotated[int, Field(strict=True, gt=0)] | None = None

    def to_library_dict(self) -> dict[str, Any]:
        return AgentRecurrenceConstraint(
            frequency=self.frequency,
            start_date=self.start_date,
            end_date=self.end_date,
            max_occurrences=self.max_occurrences,
        ).to_dict()


class ReferenceConstraintModel(_ConstraintBase):
    """Binds a payment mandate to a checkout mandate.

    The library *injects* this itself in `create_layer2_autonomous` — it computes
    `conditional_transaction_id` from the checkout disclosure hash at signing time, because only then
    is that hash known. A caller cannot supply a correct one, so accepting it and overwriting it
    silently would be a lie about what was signed. Refused with `CS_VALIDATION`.

    `conditional_transaction_id` is declared (and excluded from serialisation) purely so the refusal
    message is this one rather than pydantic's generic "extra inputs are not permitted".
    """

    type: Literal["mandate.payment.reference"]
    conditional_transaction_id: str | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _refused(self) -> ReferenceConstraintModel:
        raise ValueError(
            "mandate.payment.reference is generated by the signing service from the checkout "
            "disclosure hash and must not be supplied by the caller"
        )

    def to_library_dict(self) -> dict[str, Any]:  # pragma: no cover - validator always raises
        return ReferenceConstraint().to_dict()


Constraint = (
    AllowedMerchantsConstraint
    | LineItemsConstraint
    | AllowedPayeesConstraint
    | AmountRangeConstraint
    | BudgetConstraint
    | RecurrenceConstraint
    | AgentRecurrenceConstraintModel
    | ReferenceConstraintModel
)

_CONSTRAINT_ADAPTER: TypeAdapter[Any] = TypeAdapter(Constraint)

#: The library hands these three back in `checked` even though it evaluates none of them. We move
#: them to `skipped` in the verify response so the Gate can see it still owes them (spec D19).
NETWORK_ENFORCED_CONSTRAINTS: frozenset[str] = frozenset(
    {
        "mandate.payment.budget",
        "mandate.payment.recurrence",
        "mandate.payment.agent_recurrence",
    }
)

CONSTRAINT_TYPES: tuple[str, ...] = (
    "mandate.checkout.allowed_merchants",
    "mandate.checkout.line_items",
    "mandate.payment.allowed_payees",
    "mandate.payment.amount_range",
    "mandate.payment.budget",
    "mandate.payment.recurrence",
    "mandate.payment.agent_recurrence",
    "mandate.payment.reference",
)

CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint
PaymentConstraint = (
    AllowedPayeesConstraint
    | AmountRangeConstraint
    | BudgetConstraint
    | RecurrenceConstraint
    | AgentRecurrenceConstraintModel
    | ReferenceConstraintModel
)


def constraint_to_dict(constraint: Any) -> dict[str, Any]:  # noqa: ANN401 - model or raw dict
    """Build a constraint's library dict from either a pydantic model or a plain dict.

    A dict goes through :func:`validate_constraint_dict` first, so this is the only path by which a
    constraint dict reaches `create_layer2_autonomous`.
    """
    if isinstance(constraint, _ConstraintBase):
        return constraint.to_library_dict()
    if isinstance(constraint, BaseModel):
        raise errors.http_error(
            "CS_VALIDATION",
            f"{type(constraint).__name__} is not a constraint model this service accepts",
        )
    if isinstance(constraint, dict):
        return validate_constraint_dict(constraint).to_library_dict()
    raise errors.http_error("CS_VALIDATION", f"constraint must be an object, got {type(constraint).__name__}")


def validate_constraint_dict(data: dict[str, Any]) -> Any:  # noqa: ANN401 - returns a union member
    """Round-trip a dict through the tagged union so unknown types fail here, at the edge.

    `spec §8.8`: the compiled output is "exactly the VI dict shapes (8 registered types)", and
    §8.5: "every constraint is re-validated by `l2/prepare`". A constraint the library does not
    recognise would survive into an L2 and only surface as a STRICT-mode violation later, by which
    point the user has already signed it.
    """
    if not isinstance(data, dict):
        raise errors.http_error("CS_VALIDATION", "constraint must be a JSON object")
    ctype = data.get("type")
    if not isinstance(ctype, str) or not ctype:
        raise errors.http_error("CS_VALIDATION", "constraint is missing a string 'type'")
    if ctype not in CONSTRAINT_TYPES:
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"Unknown constraint type {ctype!r}. Countersign registers exactly {len(CONSTRAINT_TYPES)}: "
            f"{', '.join(CONSTRAINT_TYPES)}",
            {"constraint_type": ctype, "known_types": list(CONSTRAINT_TYPES)},
        )
    try:
        return _CONSTRAINT_ADAPTER.validate_python(data)
    except errors.HTTPException:  # pragma: no cover - defensive
        raise
    except Exception as exc:  # noqa: BLE001 - pydantic raises ValidationError subclasses
        raise errors.http_error(
            "VI_CONSTRAINT_VIOLATION",
            f"Constraint of type {ctype!r} does not match the registered shape: {_clean(exc)}",
            {"constraint_type": ctype},
        ) from exc


def _clean(exc: Exception) -> str:
    """A one-line, secret-free summary of a pydantic error."""
    from pydantic import ValidationError

    if isinstance(exc, ValidationError):
        parts = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err.get("loc", ()))
            parts.append(f"{loc or '<root>'}: {err.get('msg', 'invalid')}")
        return "; ".join(parts)
    return str(exc).splitlines()[0] if str(exc) else type(exc).__name__


# --- keys routes ----------------------------------------------------------------------------------


class MintAgentKeyRequest(StrictModel):
    agent_id: NonEmptyStr("`agt_…` id of the agent this key belongs to", max_length=128)


class MintAgentKeyResponse(BaseModel):
    kid: str
    public_jwk: dict[str, Any]
    enc_private_key_b64: NonEmptyStr(
        "AES-256-GCM under VI_KEK, base64. Layout nonce(12)||ciphertext||tag(16). "
        "The plaintext private key is never returned or stored here."
    )


class RotateKeyRequest(StrictModel):
    role: Literal["ISSUER", "MERCHANT"]


class RotateKeyResponse(BaseModel):
    new_kid: str
    role: str
    retired_kid: str


class JwksResponse(BaseModel):
    keys: list[dict[str, Any]]


# --- L1 -------------------------------------------------------------------------------------------


class WalletRef(StrictModel):
    payer_id: NonEmptyStr("PayPal payer id", max_length=128)
    payer_email: NonEmptyStr("Buyer's PayPal email", max_length=320)
    payment_token_id: NonEmptyStr(
        "PayPal vault payment-token id (spec V9/V10). Hashed to derive `card_id`; never echoed back.",
        max_length=256,
    )


class L1IssueRequest(StrictModel):
    user_id: NonEmptyStr("`usr_…`", max_length=128)
    wallet: WalletRef
    device_public_jwk: PublicJwk
    device_kid: NonEmptyStr("`kid` the browser will put in the L2 header", max_length=256) = "device-key-1"
    ttl_days: Annotated[
        int,
        Field(strict=True, ge=1, le=L1_TTL_DAYS_MAX, description="Lifetime in days. ≤ 365 per spec §8.3."),
    ] = 365
    pan_last_four: Annotated[str, Field(pattern=r"^\d{4}$")] = "0000"
    scheme: NonEmptyStr("Card scheme or wallet brand", max_length=64) = "PayPal"


class L1IssueResponse(BaseModel):
    l1: str
    iat: int
    exp: int
    issuer_kid: str
    card_id: str
    device_jkt: str


# --- L2 two-phase (spec D3, §11 C3(a)) ------------------------------------------------------------


class PaymentInstrument(StrictModel):
    """`{type, id, description}` — required by the library on both the open payment mandate and
    the closed L3a one, and cross-checked between them."""

    type: NonEmptyStr("`paypal_vault` in Countersign", max_length=128)
    id: NonEmptyStr("Instrument id. Per spec §8.3 this is sha256(payment_token_id).", max_length=256)
    description: NonEmptyStr("Buyer-facing label, e.g. 'PayPal ····'", max_length=256)


class L2PrepareRequest(StrictModel):
    l1: NonEmptyStr("The L1 SD-JWT the browser will bind its L2 to", max_length=32768)
    device_kid: NonEmptyStr(
        "kid for the L2 header; must be the key bound in the L1's `cnf.jwk`", max_length=256
    )
    agent_public_jwk: PublicJwk
    agent_kid: NonEmptyStr("`kid` for the agent key this mandate delegates to", max_length=256)
    checkout_constraints: Annotated[list[dict[str, Any]], Field(default_factory=list)]
    payment_constraints: Annotated[list[dict[str, Any]], Field(default_factory=list)]
    merchants: Annotated[
        list[MerchantRef],
        Field(
            description=(
                "Selectively-disclosable merchant entries referenced by id from the constraints above."
            )
        ),
    ]
    acceptable_items: Annotated[list[AcceptableItem], Field(default_factory=list)]
    payment_instrument: PaymentInstrument
    nonce: NonEmptyStr(
        "Replay nonce. Must match the L3 nonce if the Gate will cross-check it.", max_length=256
    )
    aud: NonEmptyStr("Agent URL this mandate is delegated to", max_length=2048)
    ttl_seconds: Annotated[
        int,
        Field(strict=True, ge=60, le=L2_TTL_SECONDS_MAX, description="≤ 2592000 (30 days) per spec §8.3."),
    ] = 604_800
    prompt_summary: NonEmptyStr(
        "What the user asked for. NOT covered by the signature: `UserMandate` has this field but "
        "`create_layer2_autonomous` at the pinned commit never serialises it into the L2 payload, so "
        "it cannot be shown as signed content (spec §8.3 names it in the request). Advisory only.",
        max_length=2000,
    ) = ""
    iss: NonEmptyStr("Wallet/issuer URL", max_length=2048) | None = None
    device_id: NonEmptyStr("`dev_…`, recorded in L2 `risk_data`", max_length=128) | None = None
    ip_address: str | None = Field(default=None, max_length=64)


class L2PrepareResponse(BaseModel):
    prepare_id: str
    signing_input: NonEmptyStr(
        "`header.payload` — the ASCII bytes the browser signs. Not a token; it has no signature yet."
    )
    header: dict[str, Any]
    payload: dict[str, Any] = Field(
        description="The decoded L2 payload. The UI MUST render this, not its own copy (spec §8.5)."
    )
    expires_at: int
    prepare_ttl_seconds: int


class L2FinalizeRequest(StrictModel):
    prepare_id: NonEmptyStr("From `l2/prepare`", max_length=128)
    signature_b64url: B64Url(
        "Raw 64-byte ES256 r‖s (P1363), base64url. Not DER: WebCrypto emits P1363 and the "
        "library's `es256_verify` rejects anything that is not exactly 64 bytes."
    )


class L2FinalizeResponse(BaseModel):
    l2: Annotated[
        str,
        Field(
            min_length=1,
            max_length=131_072,
            description="`signing_input.signature_b64url~d1~d2~…~` — the finished L2, disclosures included.",
        ),
    ]
    iat: int
    exp: int | None = None
    agent_kid: str


# --- checkout JWT (spec §8.3, EC-FX-6) ------------------------------------------------------------


class CheckoutLine(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: NonEmptyStr("SKU from the seeded catalog", max_length=128)
    title: NonEmptyStr("Product title, locked into the price lock", max_length=512)
    qty: Annotated[int, Field(strict=True, ge=1, le=1000, description="Integer quantity.")]
    unit_minor: Annotated[
        int, Field(strict=True, ge=0, description="Unit price in minor units. Never a float.")
    ]


class CheckoutJwtRequest(StrictModel):
    merchant: MerchantRef
    lines: Annotated[list[CheckoutLine], Field(min_length=1)]
    shipping_minor: Annotated[int, Field(strict=True, ge=0)] = 0
    tax_minor: Annotated[int, Field(strict=True, ge=0)] = 0
    currency: Currency
    ttl_seconds: Annotated[int, Field(strict=True, ge=30, le=CHECKOUT_TTL_SECONDS_MAX)] = 900
    checkout_id: NonEmptyStr("`chk_…` recorded against this price lock", max_length=128) | None = None


class CheckoutJwtResponse(BaseModel):
    checkout_jwt: str
    checkout_hash: NonEmptyStr(
        "base64url SHA-256 of the ASCII JWT bytes. Byte-identical to what the library recomputes."
    )
    exp: int
    total_minor: int
    currency: Currency
    kid: str


# --- L3 -------------------------------------------------------------------------------------------


class L3Payment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_minor: Annotated[
        int, Field(strict=True, ge=0, description="Integer minor units. Refused out of range at l3/create.")
    ]
    currency: Currency
    payee_id: NonEmptyStr("Must be in the L2's `allowed_payees`", max_length=128)


class L3CreateRequest(StrictModel):
    agent_kid: NonEmptyStr("The `agt_…` key this L3 must be signed with", max_length=256)
    enc_private_key_b64: NonEmptyStr("AES-256-GCM ciphertext from `POST /v1/keys/agent`", max_length=4096)
    l2: NonEmptyStr("The full L2 SD-JWT as stored on the mandate", max_length=65536)
    checkout_jwt: NonEmptyStr("The merchant-signed, price-locked checkout JWT", max_length=32768)
    payment: L3Payment
    aud: NonEmptyStr("Payment network URL for L3a", max_length=2048)
    nonce: NonEmptyStr("Replay nonce; must match the L2 nonce", max_length=256)
    iss: NonEmptyStr("Agent URL", max_length=2048) | None = None
    ttl_seconds: Annotated[int, Field(strict=True, ge=30, le=L3_TTL_SECONDS_MAX)] = L3_TTL_SECONDS_DEFAULT
    agent_id: NonEmptyStr("`agt_…`; used as AEAD associated data", max_length=128) | None = None


class L3CreateResponse(BaseModel):
    l3a: str
    l3b: str
    jti: NonEmptyStr(
        "Replay id: base64url SHA-256 of this response's L3a issuer JWT. It is a pure function of "
        "the signed L3a bytes, so re-submitting the same signed L3 yields the same jti and the "
        "UNIQUE `checkout_attempts_l3_jti_key` index refuses the replay (Gate check 7, EC-IDEM-1). "
        "It is NOT stable across retries of this request — a retried `l3/create` mints new "
        "disclosure salts and a new iat, so it is a new authorisation with a new jti. Retry "
        "idempotency comes from the deterministic `PayPal-Request-Id` on the PayPal call (spec "
        "§8.6), not from this. See docs/DECISIONS.md D-011."
    )
    iat: int
    exp: int
    checkout_hash: str
    payment_presentation: str = Field(
        description="`l2_base~payment_disclosure~merchant_disclosure~` — the L2 slice the network sees."
    )
    checkout_presentation: str = Field(
        description="`l2_base~checkout_disclosure~item_disclosure~` — the L2 slice the merchant sees."
    )


# --- verify ---------------------------------------------------------------------------------------


class VerifyRequest(BaseModel):
    """`POST /v1/verify`. Deliberately *not* `extra="forbid"`-strict: an invalid chain must still
    be a 200 with reasons, and an unrecognised field is not a reason to 422 the whole request."""

    model_config = ConfigDict(extra="forbid")

    l1: NonEmptyStr("L1 SD-JWT", max_length=65536)
    l2: NonEmptyStr("L2 SD-JWT with disclosures", max_length=131072)
    l3a: str | None = Field(default=None, max_length=65536)
    l3b: str | None = Field(default=None, max_length=65536)
    checkout_jwt: str | None = Field(default=None, max_length=32768)
    expected_aud: str | None = Field(default=None, max_length=2048)
    expected_nonce: str | None = Field(default=None, max_length=256)
    at_time: int | None = Field(
        default=None,
        description=(
            "EC-TIME-3: verify 'as of capture time'. The pinned library has no time override "
            "(see `at_time_not_honoured`), so this is reported as an advisory window check."
        ),
    )
    strict: bool = True


class AtTimeCheck(BaseModel):
    requested: int
    honoured: bool = Field(description="False while the library exposes no clock override.")
    reason: str
    within_validity_at: bool = Field(
        description="Advisory only: our own iat/exp window check at `requested`, with the configured skew."
    )
    within_validity_now: bool
    l1_exp: int | None = None
    l2_exp: int | None = None


class SkippedConstraint(BaseModel):
    """One constraint the library did not evaluate, and why.

    Structured rather than a bare annotated string on purpose. `skipped` used to be `list[str]` where
    each entry was either a bare constraint type (from the library) or `"<type> - Network-enforced
    constraints. Not evaluated by…"`, mixed together. A Gate asking
    `skipped.includes('mandate.payment.budget')` then gets `false` **while a signed budget cap sits
    unevaluated**, so the Gate concludes it owes nothing — precisely the failure spec D19 exists to
    prevent. Splitting `type` from `reason` makes membership a `skipped.some(s => s.type === …)` and
    removes the trap.

    `type` is a synthetic name for a whole evaluation that did not run at all (for example
    `"checkout_constraint_evaluation"`), because sometimes nothing was skipped individually; the
    category itself could not be evaluated.
    """

    type: str
    reason: str


class ConstraintReport(BaseModel):
    satisfied: bool
    violations: list[str]
    #: Constraint types the library actually evaluated. Bare types, so membership is exact.
    checked: list[str]
    skipped: list[SkippedConstraint]


class DisclosedReport(BaseModel):
    l1: dict[str, Any] = Field(default_factory=dict)
    l2: dict[str, Any] = Field(default_factory=dict)
    l3a: dict[str, Any] = Field(default_factory=dict)
    l3b: dict[str, Any] = Field(default_factory=dict)


class KeyReport(BaseModel):
    issuer_kid: str | None = None
    device_jkt: str | None = None
    agent_kid: str | None = None
    device_kid: str | None = None
    merchant_kid: str | None = None


class VerifyResponse(BaseModel):
    chain_valid: bool
    errors: list[str]
    constraints: ConstraintReport
    disclosed: DisclosedReport
    keys: KeyReport
    checks_performed: list[str] = Field(default_factory=list)
    checks_skipped: list[str] = Field(default_factory=list)
    verified_at: int
    clock_skew_seconds: int
    at_time_not_honoured: bool = False
    at_time_reason: str | None = None
    at_time_check: AtTimeCheck | None = None


class EvidenceBundle(BaseModel):
    """The evidence packet's chain material (spec §7.3). Only the chain fields are verified here."""

    model_config = ConfigDict(extra="allow")

    v: str | None = None
    l1: NonEmptyStr("L1 SD-JWT", max_length=65536)
    l2: NonEmptyStr("L2 SD-JWT", max_length=131072)
    l3a: str | None = Field(default=None, max_length=65536)
    l3b: str | None = Field(default=None, max_length=65536)
    checkout_jwt: str | None = Field(default=None, max_length=32768)
    gate_decision: str | None = Field(default=None, max_length=32768)
    vi_lib_commit: str | None = None


class PublicVerifyRequest(StrictModel):
    bundle: EvidenceBundle
    expected_aud: str | None = Field(default=None, max_length=2048)
    expected_nonce: str | None = Field(default=None, max_length=256)
    at_time: int | None = None


class PublicVerifyResponse(VerifyResponse):
    bundle_hash: NonEmptyStr(
        "base64url SHA-256 over the RFC 8785 (JCS) canonical form of the bundle, exactly as "
        "spec §7.3 hashes `custom_id`."
    )


class StatusResponse(BaseModel):
    ok: bool
    app_env: str
    issuer_kid: str
    merchant_kid: str
    clock_skew_seconds: int
