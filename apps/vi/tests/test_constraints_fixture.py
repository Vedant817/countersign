"""Generate `tests/constraint_shapes.json` — the machine-readable constraint contract (spec §8.8 [B3]).

Spec §8.8 requires it by name:

> Field names MUST be taken from `verifiable_intent/models/constraints.py` (`to_dict`) at the pinned
> commit [B3]. … WP-08 writes a pytest-generated JSON fixture of every constraint's `to_dict()`
> output, and the zod schemas are tested against it.

So this file *is* that generator, and it reads the field names off the library at runtime rather than
from a hand-copied list. A hand-copied list is exactly how the two runtimes drift apart: someone adds
an optional field upstream, zod stays strict, and a real intent fails to compile in production.

Shape::

    {
      "mandate.checkout.allowed_merchants": { ... one example to_dict() ... },
      ... one entry per registered type ...
      "__meta__": { "vi_lib_commit": "356c296…", "generated_by": "…", … }
    }

`__meta__` records the pinned commit so a fixture generated against a different library is obvious
rather than silently wrong.

Run just this file to regenerate::

    uv run pytest tests/test_constraints_fixture.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from verifiable_intent.models.constraints import (
    AgentRecurrenceConstraint,
    AllowedMerchantConstraint,
    AllowedPayeeConstraint,
    CheckoutLineItemsConstraint,
    PaymentAmountConstraint,
    PaymentBudgetConstraint,
    PaymentRecurrenceConstraint,
    ReferenceConstraint,
    parse_constraint,
)

from vi_service import VI_LIB_COMMIT
from vi_service.models import (
    CONSTRAINT_TYPES,
    NETWORK_ENFORCED_CONSTRAINTS,
    validate_constraint_dict,
)

FIXTURE_PATH = Path(__file__).parent / "constraint_shapes.json"

# Inner dict shapes copied from `examples/autonomous_flow.py::MERCHANTS` / `ACCEPTABLE_ITEMS`, per
# spec §8.8: "Inner dict shapes … MUST be copied from examples/autonomous_flow.py, not invented."
EXAMPLE_MERCHANT: dict[str, Any] = {
    "id": "mrc_northwind",
    "name": "Northwind Outfitters",
    "website": "https://northwind.countersign.test",
}
EXAMPLE_ITEM: dict[str, Any] = {"id": "SKU-TRAIL-42", "title": "Trail Runner"}

#: One input dict per registered type. `parse_constraint` turns each into its dataclass.
EXAMPLES: dict[str, dict[str, Any]] = {
    "mandate.checkout.allowed_merchants": {
        "type": "mandate.checkout.allowed_merchants",
        "allowed": [EXAMPLE_MERCHANT],
    },
    "mandate.checkout.line_items": {
        "type": "mandate.checkout.line_items",
        "items": [{"id": "line-item-1", "acceptable_items": [EXAMPLE_ITEM], "quantity": 1}],
        "match_mode": "minimum",
    },
    "mandate.payment.allowed_payees": {
        "type": "mandate.payment.allowed_payees",
        "allowed": [EXAMPLE_MERCHANT],
    },
    "mandate.payment.amount_range": {
        "type": "mandate.payment.amount_range",
        "currency": "USD",
        "min": 0,
        "max": 13000,
    },
    "mandate.payment.budget": {
        "type": "mandate.payment.budget",
        "currency": "USD",
        "max": 13000,
    },
    "mandate.payment.recurrence": {
        "type": "mandate.payment.recurrence",
        "frequency": "MNTH",
        "start_date": "2026-10-01",
        "end_date": "2027-10-01",
        "number": 12,
    },
    "mandate.payment.agent_recurrence": {
        "type": "mandate.payment.agent_recurrence",
        "frequency": "MNTH",
        "start_date": "2026-10-01",
        "end_date": "2027-10-01",
        "max_occurrences": 12,
    },
    "mandate.payment.reference": {
        "type": "mandate.payment.reference",
        # A placeholder hash. The real value is computed by `create_layer2_autonomous` from the
        # checkout disclosure, which is why the service refuses to accept this from a caller.
        "conditional_transaction_id": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
}


def build_fixture() -> dict[str, Any]:
    """Every registered type's `to_dict()`, read off the library."""
    fixture: dict[str, Any] = {}
    for ctype, example in EXAMPLES.items():
        fixture[ctype] = parse_constraint(example).to_dict()
    fixture["__meta__"] = {
        "vi_lib_commit": VI_LIB_COMMIT,
        "generated_by": "apps/vi/tests/test_constraints_fixture.py",
        "source": "verifiable_intent/models/constraints.py at the pinned commit",
        "count": len(EXAMPLES),
        # Recorded so a consumer (WP-08's zod schemas) knows which of these three are never evaluated
        # by the library and are enforced by the Countersign Gate instead (spec D19).
        "network_enforced_not_checked_by_library": sorted(NETWORK_ENFORCED_CONSTRAINTS),
        "reference_is_generated_by_the_service": ["mandate.payment.reference"],
        "currencies": ["USD", "EUR", "GBP", "INR", "JPY", "AUD", "CAD"],
        "iso_20022_frequencies": [
            "INDA",
            "DAIL",
            "WEEK",
            "TWOK",
            "TWMN",
            "MNTH",
            "TOMN",
            "QUTR",
            "FOMN",
            "SEMI",
            "YEAR",
            "TYEA",
        ],
        "money": "integer minor units plus an ISO-4217 currency code; never a float (spec §0, EC-FX-6)",
    }
    return fixture


def test_constraint_fixture_is_written() -> None:
    """Write (or rewrite) `constraint_shapes.json`. The fixture is a committed artefact."""
    FIXTURE_PATH.write_text(
        json.dumps(build_fixture(), indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    assert FIXTURE_PATH.exists()


def test_fixture_covers_exactly_the_eight_registered_types() -> None:
    """The library's registry and our `CONSTRAINT_TYPES` must not drift.

    Both are read here, so a new upstream type fails this test rather than silently going unmodelled.
    """
    from verifiable_intent.models.constraints import _REGISTRY

    assert set(_REGISTRY) == set(CONSTRAINT_TYPES)
    assert len(CONSTRAINT_TYPES) == 8
    assert set(build_fixture()) - {"__meta__"} == set(CONSTRAINT_TYPES)


def test_fixture_round_trips_through_parse_constraint() -> None:
    """Each fixture entry is itself a valid constraint dict.

    This is what makes the fixture usable as a *contract*: WP-08 can feed it straight into zod and
    the result is what `parse_constraint` will later accept.
    """
    for ctype, shape in build_fixture().items():
        if ctype == "__meta__":
            continue
        reparsed = parse_constraint(shape)
        assert reparsed.type == ctype
        assert reparsed.to_dict() == shape, f"{ctype} does not round-trip"


def test_fixture_shapes_match_the_library_field_for_field() -> None:
    """Every key in each fixture entry is a real dataclass field.

    Read from `__dataclass_fields__`, so an upstream rename or a new optional field shows up here
    instead of in production. Optional fields are allowed to be *absent* — `to_dict()` omits them
    rather than emitting null, which the test right below pins down.
    """
    for ctype, shape in build_fixture().items():
        if ctype == "__meta__":
            continue
        constraint = parse_constraint(shape)
        declared = set(type(constraint).__dataclass_fields__) - {"type", "extra_fields"}
        produced = set(shape) - {"type"}
        assert produced <= declared, (
            f"{ctype}: to_dict() emitted fields that do not exist: {produced - declared}"
        )
        assert produced, f"{ctype}: to_dict() emitted nothing but the type"


def test_every_optional_field_appears_somewhere_in_the_fixture() -> None:
    """The union over all examples covers every declared field.

    Together with `test_optional_fields_are_omitted_rather_than_null` this means a zod schema author
    sees both ends of every optional: which fields exist, and what happens when they are left out.
    """
    declared_union: set[str] = set()
    produced_union: set[str] = set()
    for ctype, shape in build_fixture().items():
        if ctype == "__meta__":
            continue
        constraint = parse_constraint(shape)
        declared_union |= set(type(constraint).__dataclass_fields__) - {"type", "extra_fields"}
        produced_union |= set(shape) - {"type"}

    optional_never_shown = declared_union - produced_union
    assert not optional_never_shown, (
        f"these fields never appear in any fixture entry, so a schema author would not see them: "
        f"{optional_never_shown}"
    )


def test_fixture_entries_pass_our_own_validator() -> None:
    """The shapes we publish are the shapes `l2/prepare` accepts.

    Without this, the fixture could describe something the service would then reject — which would
    make it a worse contract than useless, because WP-08 would build zod that our own route refuses.
    """
    for ctype, shape in build_fixture().items():
        if ctype == "__meta__":
            continue
        if ctype == "mandate.payment.reference":
            continue  # refused by design: the service computes it at signing time
        validated = validate_constraint_dict(shape)
        assert validated.to_library_dict() == shape, ctype


def test_budget_max_must_be_a_positive_integer() -> None:
    """The library raises `ValueError` on `max <= 0`; we refuse it earlier, as `CS_VALIDATION`.

    Worth its own assertion because it is the one constraint whose dataclass *throws* on construction.
    A consumer generating a schema from this fixture needs to know `max` is `> 0`, not `>= 0`.
    """
    for bad in (0, -1, -13_000):
        with pytest.raises(ValueError, match="positive integer"):
            PaymentBudgetConstraint(currency="USD", max=bad)

    with pytest.raises(ValueError, match="positive integer"):
        PaymentBudgetConstraint(currency="USD", max=1000, min=0)


def test_optional_fields_are_omitted_rather_than_null() -> None:
    """An omitted optional key is absent from `to_dict()`, not present-and-null.

    This matters for zod: `.optional()` accepts `undefined` but not `null`, so if we emitted
    `"min": null` the generated schema would reject our own fixture.
    """
    minimal = PaymentAmountConstraint(currency="USD").to_dict()
    assert minimal == {"type": "mandate.payment.amount_range", "currency": "USD"}

    minimal_budget = PaymentBudgetConstraint(currency="USD", max=1).to_dict()
    assert minimal_budget == {"type": "mandate.payment.budget", "currency": "USD", "max": 1}

    minimal_recurrence = PaymentRecurrenceConstraint(frequency="MNTH", start_date="2026-10-01").to_dict()
    assert minimal_recurrence == {
        "type": "mandate.payment.recurrence",
        "frequency": "MNTH",
        "start_date": "2026-10-01",
    }


def test_the_optional_fields_become_present_when_supplied() -> None:
    """The mirror of the test above, so a consumer can see both ends of every optional."""
    full = PaymentRecurrenceConstraint(
        frequency="MNTH", start_date="2026-10-01", end_date="2027-10-01", number=12
    ).to_dict()
    assert full == {
        "type": "mandate.payment.recurrence",
        "frequency": "MNTH",
        "start_date": "2026-10-01",
        "end_date": "2027-10-01",
        "number": 12,
    }

    agent = AgentRecurrenceConstraint(
        frequency="WEEK", start_date="2026-10-01", end_date="2026-12-01", max_occurrences=8
    ).to_dict()
    assert agent == {
        "type": "mandate.payment.agent_recurrence",
        "frequency": "WEEK",
        "start_date": "2026-10-01",
        "end_date": "2026-12-01",
        "max_occurrences": 8,
    }


def test_the_network_enforced_three_are_the_ones_the_library_declines_to_evaluate() -> None:
    """Cross-check our list against the library's own docstrings.

    `verification/constraint_checker.py` appends exactly these three to `checked` under the comment
    "Network-enforced constraints". If the library's set changed, this list has to change with it.
    """
    from verifiable_intent.verification.constraint_checker import check_constraints

    result = check_constraints(
        [
            EXAMPLES[t]
            for t in (
                "mandate.payment.budget",
                "mandate.payment.recurrence",
                "mandate.payment.agent_recurrence",
            )
        ],
        {"payment_amount": {"currency": "USD", "amount": 1}},
    )
    appended_without_evaluating = {
        name for name in result.checked if name in set(CONSTRAINT_TYPES) - {"mandate.payment.reference"}
    }
    assert appended_without_evaluating == set(NETWORK_ENFORCED_CONSTRAINTS)

    for ctype in NETWORK_ENFORCED_CONSTRAINTS:
        constraint_class = type(parse_constraint(EXAMPLES[ctype]))
        assert "Network-enforced" in (constraint_class.__doc__ or ""), (
            f"{ctype} is expected to be documented as network-enforced upstream"
        )


def test_every_remaining_type_is_actually_evaluated_by_the_library() -> None:
    """The complement of the test above: nothing else is quietly unenforced.

    If a fourth type were ever added to the library's "skip" branch, this is where it would surface.
    """
    from verifiable_intent.verification.constraint_checker import check_constraints

    evaluated = {
        "mandate.checkout.allowed_merchants",
        "mandate.checkout.line_items",
        "mandate.payment.allowed_payees",
        "mandate.payment.amount_range",
        "mandate.payment.reference",
    }
    assert evaluated == set(CONSTRAINT_TYPES) - NETWORK_ENFORCED_CONSTRAINTS

    result = check_constraints(
        [EXAMPLES[t] for t in sorted(evaluated - {"mandate.payment.reference"})],
        {
            "merchant": EXAMPLE_MERCHANT,
            "line_items": [{"id": EXAMPLE_ITEM["id"], "quantity": 1}],
            "allowed_merchants": [EXAMPLE_MERCHANT],
            "payee": EXAMPLE_MERCHANT,
            "payment_amount": {"currency": "USD", "amount": 500},
        },
        mode=__import__(
            "verifiable_intent.verification.constraint_checker", fromlist=["StrictnessMode"]
        ).StrictnessMode.STRICT,
    )
    assert result.satisfied is True, result.violations


def test_the_library_registry_cannot_be_bypassed_with_an_unknown_type() -> None:
    """An unrecognised type survives `parse_constraint` untouched — which is why we refuse it earlier.

    `parse_constraint` does not reject unknown types; it wraps them in a base `Constraint`. Left
    alone, an unknown type would ride through into a signed L2 and only be noticed at verification
    time, after the user had already signed. `validate_constraint_dict` is what closes that gap.
    """
    unknown = {"type": "mandate.payment.hodl", "max": 1_000_000}
    wrapped = parse_constraint(unknown)

    assert wrapped.type == "mandate.payment.hodl"
    assert wrapped.to_dict() == unknown

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        validate_constraint_dict(unknown)
    assert excinfo.value.status_code == 422
    assert excinfo.value.detail["error"]["code"] == "VI_CONSTRAINT_VIOLATION"


def test_the_reference_constraint_is_generated_by_the_service_not_the_caller() -> None:
    """`mandate.payment.reference` is in the fixture, but `/v1/l2/prepare` refuses a caller-supplied one.

    `create_layer2_autonomous` computes `conditional_transaction_id` from the checkout disclosure hash
    at signing time, because only then is that hash known. A caller-supplied value could not be right,
    so accepting one silently would be a lie about what was signed.
    """
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        validate_constraint_dict(EXAMPLES["mandate.payment.reference"])
    assert excinfo.value.status_code == 422
    assert "generated by the signing service" in excinfo.value.detail["error"]["message"]

    # The library does build it, from the checkout disclosure. This is the shape it produces.
    assert ReferenceConstraint(conditional_transaction_id="abc").to_dict() == {
        "type": "mandate.payment.reference",
        "conditional_transaction_id": "abc",
    }


def test_fixture_file_on_disk_matches_what_this_module_generates() -> None:
    """The committed file is current. Run this file after any library bump to regenerate it."""
    assert FIXTURE_PATH.exists(), "run `uv run pytest tests/test_constraints_fixture.py` to generate it"
    on_disk = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert on_disk == build_fixture(), (
        "apps/vi/tests/constraint_shapes.json is stale — regenerate it by running this test file"
    )


def test_fixture_declares_the_pinned_commit() -> None:
    """`__meta__` names the library commit, so a fixture from another pin is obvious."""
    meta = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["__meta__"]

    assert meta["vi_lib_commit"] == VI_LIB_COMMIT
    assert len(meta["vi_lib_commit"]) == 40
    assert meta["count"] == 8
    assert meta["money"].startswith("integer minor units")


def test_the_five_dataclass_types_we_do_not_construct_directly_are_still_covered() -> None:
    """Guard against an example dict being added for a type we forget to round-trip.

    Named explicitly rather than derived, because the point is to fail when someone adds a ninth
    constraint to the spec and does not update this test.
    """
    fixture = build_fixture()
    for ctype in (
        "mandate.checkout.allowed_merchants",
        "mandate.checkout.line_items",
        "mandate.payment.allowed_payees",
        "mandate.payment.amount_range",
        "mandate.payment.budget",
        "mandate.payment.recurrence",
        "mandate.payment.agent_recurrence",
        "mandate.payment.reference",
    ):
        assert fixture[ctype]["type"] == ctype

    assert AllowedMerchantConstraint is not None  # imported for the registry cross-check above
    assert AllowedPayeeConstraint is not None
    assert CheckoutLineItemsConstraint is not None
