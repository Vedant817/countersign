/**
 * The downloadable `verify.py` — spec **§8.18**: *"'Verify offline' offers a downloadable `verify.py` snippet
 * that uses the pinned library"*, work package **WP-18**.
 *
 * ## Why this is a generated file and not a code block in the page
 *
 * Three reasons, in increasing order of how much they would hurt if we got it wrong:
 *
 * 1. **A code block is not evidence.** §18 judge question 47 is "show me a way to verify your claims
 *    independently". A reader who has to retype a script has not verified anything; they have trusted us once
 *    more, with a copy-paste step in the middle. `apps/web/app/v/[packetId]/verify-now/route.ts` serves this
 *    file as `text/x-python` with `Content-Disposition: attachment`, so "Save as `verify.py`" is the whole
 *    interaction.
 * 2. **The digest has to be inside it.** The script embeds the packet's published `bundle_hash`,
 *    `custom_id`, `readback_sha256` and `preferences_sha256`. That is what makes the run *falsifiable*: the
 *    script recomputes each digest and compares, so a reader can tell whether the file they downloaded is
 *    the one we published. A script with no embedded digest could only report what the input says about
 *    itself, which proves nothing.
 * 3. **It has to run with no Countersign server involved.** The script makes no network call of any kind. It
 *    carries the public keys it needs, because `verify_chain` takes the issuer key as an argument and there
 *    is nowhere else to get one without asking us.
 *
 * ## The three phases, and why phases 1–2 alone decide the exit code
 *
 * | Phase | Needs | Contributes to the exit code |
 * |---|---|---|
 * | 1. Integrity | `hashlib` only | **yes** |
 * | 2. Binding | `hashlib` only | **yes** |
 * | 3. Signatures | the pinned Verifiable Intent library | yes — but expiry is a `WARN`, not a `FAIL` |
 *
 * Phase 1 is where **every** field tamper lands: `custom_id` covers the nine hashed members and
 * `bundle_hash` covers the whole document, so editing `l1`, `l2`, `l3a`, `l3b`, `checkout_jwt`,
 * `gate_decision`, `readback`, `preferences`, `paypal` or `shipments` changes at least one digest. That is
 * AT-M18.1 answered for every field category by construction, which is why the verdict does not depend on the
 * library being installed: **a machine with no `verifiable_intent` still detects every tamper.**
 *
 * ### Phase 3 is expiry-tolerant, and that is not a weakening
 *
 * The pinned `verify_chain` reads `time.time()` internally and exposes no override (D-009), so a mandate
 * whose `ttl_seconds` has elapsed produces an expiry error **forever** — including on a bundle nobody touched.
 * A script that failed on expiry would be a permanent false alarm on every historical packet, and a reader who
 * learns to ignore one red line stops reading the page. So an expiry-only failure is reported as `[WARN]` and
 * does not change the exit code; a **signature mismatch, a chain error or a missing member** is `[FAIL]` and
 * does. The script states which rule it applied, so the reader sees the distinction rather than trusting it.
 *
 * ### Anything phase 3 could not do is a loud `SKIP`, never a silent pass
 *
 * A missing library, an unrecognised shape, a key we did not publish: each prints `[SKIP]` with the reason on
 * stdout and is listed in the summary. A verifier that quietly narrows its own scope is the failure mode this
 * whole page exists to avoid.
 *
 * ## `subprocess` in the test, not a mock
 *
 * `test/verify-py.test.ts` writes this file and a bundle to disk and runs it with `uv run --project apps/vi
 * python`. There is no stubbed interpreter and no hand-written expectation about what it prints — the test
 * asserts on the **exit code and the stdout it actually produced**. If `uv` or the pinned library is absent the
 * suite skips with a printed reason rather than passing vacuously.
 */

import {
  BUNDLE_VERSION,
  bundleHashBase64Url,
  canonicalBundleCore,
  canonicalBundleJson,
  customIdForBundle,
  EXCLUDED_FROM_CUSTOM_ID,
  HASHED_MEMBERS,
} from './bundle'

/** One public key the offline script needs in order to verify a signature with no network. */
export interface VerifyPyKey {
  readonly kid: string
  readonly role: 'ISSUER' | 'MERCHANT' | 'GATE' | 'AGENT'
  readonly public_jwk: Record<string, unknown>
}

/** Everything {@link renderVerifyPy} bakes in. All of it comes from the packet row, none from the request. */
export interface VerifyPyInput {
  readonly packetId: string
  readonly bundle: Readonly<Record<string, unknown>>
  /** `evidence_packets.bundle_hash`, hex. If this disagrees with a recomputation, the script fails. */
  readonly bundleHashHex: string
  readonly keys: readonly VerifyPyKey[]
  /** The Gate key, so the script can also check our own signature on the decision record. */
  readonly gateKid: string | null
}

/**
 * The generated file's text.
 *
 * **Deterministic for a given input** — no timestamps, no random ids, no dict iteration order — so a test can
 * assert that regenerating it for an untampered bundle reproduces it byte for byte. A generated artefact that
 * changed on every request could not be diffed against a published copy, which is the only way a reader would
 * notice we regenerated it with different constants.
 */
export function renderVerifyPy(input: VerifyPyInput): string {
  const issuerKey = input.keys.find((k) => k.role === 'ISSUER') ?? null
  const merchantKey = input.keys.find((k) => k.role === 'MERCHANT') ?? null
  const gateKey = input.keys.find((k) => k.role === 'GATE') ?? null

  const published: Record<string, unknown> = {
    PACKET_ID: input.packetId,
    BUNDLE_VERSION,
    HASHED_MEMBERS: [...HASHED_MEMBERS],
    EXCLUDED_FROM_CUSTOM_ID: [...EXCLUDED_FROM_CUSTOM_ID],
    PUBLISHED_BUNDLE_HASH_HEX: input.bundleHashHex,
    PUBLISHED_BUNDLE_HASH_B64URL: bundleHashBase64Url(input.bundle),
    PUBLISHED_CUSTOM_ID: customIdForBundle(input.bundle),
    PUBLISHED_READBACK_SHA256: readString(input.bundle, 'readback_sha256'),
    PUBLISHED_PREFERENCES_SHA256: readString(input.bundle, 'preferences_sha256'),
    GATE_KID: input.gateKid,
    ISSUER_KID: issuerKey?.kid ?? null,
    ISSUER_JWK: issuerKey?.public_jwk ?? null,
    MERCHANT_KID: merchantKey?.kid ?? null,
    MERCHANT_JWK: merchantKey?.public_jwk ?? null,
    GATE_JWK: gateKey?.public_jwk ?? null,
    /** Shown so a reader can see the exact bytes `custom_id` was taken over. */
    PUBLISHED_CANONICAL_CORE: canonicalBundleJson(canonicalBundleCore(input.bundle)),
  }

  return `${DOC_HEADER}\nPUBLISHED: dict[str, object] = ${pythonLiteral(published)}\n${BODY}`
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Render a value as a **Python** literal.
 *
 * ### Why not `JSON.stringify`
 *
 * Because JSON is not Python. `JSON.stringify(null)` emits `null`, which Python parses as a `NameError` at
 * import time — so the generated file would not even load. An earlier draft did exactly this and the file
 * died on line 104 with `NameError: name 'null' is not defined`, which is why this is a hand-written
 * serialiser rather than a one-liner: a generated script that cannot be imported is worth nothing, and the
 * failure only shows up when someone runs it.
 *
 * The three conversions that matter, and each is a place the obvious implementation is wrong:
 *
 * | JSON      | Python  | the trap |
 * |-----------|---------|----------|
 * | `null`    | `None`  | a `NameError` at import, not a parse error |
 * | `true`    | `True`  | capitalised |
 * | `false`   | `False` | capitalised |
 *
 * Numbers are emitted through `JSON.stringify`, which is safe here because every embedded number is an
 * integer or a string — the bundle digests are 64-character hex strings and the keys hold base64url strings.
 * A float would reach this function as `13300.0`, which Python and JavaScript both read as a double, and a
 * float in a canonicalisation constant would be exactly the EC-FX-6 defect the rest of the package refuses.
 *
 * Strings go through `JSON.stringify`, which escapes non-ASCII as `\uXXXX` and never emits a lone surrogate.
 * Python's string literal parser decodes both, so the output is always importable — a property
 * `json.dumps(..., ensure_ascii=False)` would *not* have.
 */
function pythonLiteral(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent)
  const padInner = '  '.repeat(indent + 1)

  if (value === null) return 'None'
  if (value === undefined) return 'None'
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      // Loud rather than silent: a float in a generated constant is a bug, and `1.0` in the file would be a
      // formatting choice the digest depended on.
      throw new Error(`verify.py: refusing to embed the non-integer ${String(value)}`)
    }
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((entry) => `${padInner}${pythonLiteral(entry, indent + 1)}`)
    return `[\n${items.join(',\n')},\n${pad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    if (entries.length === 0) return '{}'
    const items = entries.map(
      ([k, v]) => `${padInner}${JSON.stringify(k)}: ${pythonLiteral(v, indent + 1)}`,
    )
    return `{\n${items.join(',\n')},\n${pad}}`
  }
  throw new Error(`verify.py: cannot embed a value of type ${typeof value}`)
}

// ---------------------------------------------------------------------------
// The generated source
// ---------------------------------------------------------------------------

const DOC_HEADER = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Countersign offline evidence verifier — generated for one packet.

    python verify.py bundle.json

    With the pinned Verifiable Intent library (phase 3):
    uv run --with 'verifiable-intent @ git+https://github.com/agent-intent/verifiable-intent@356c29635f1c44df7de02edb58699ca9f29bece6' \\
      python verify.py bundle.json

WHAT THIS IS
    The strongest claim this project makes. It re-checks the evidence packet with no Countersign server
    involved: no HTTP, no database, no API key. Everything it needs is either in the bundle you downloaded
    or baked into this file.

WHAT IT CHECKS, AND WHAT EACH CHECK PROVES
    Phase 1 — integrity (hashlib only, no dependencies)
        bundle_hash         SHA-256 over the RFC 8785 canonical form of the whole bundle, against the
                            value Countersign published. ANY edit to ANY field changes this.
        custom_id           "cs1:" + base64url(SHA-256(JCS(nine core members))). This is the string
                            PayPal's own order record carries, so a match means the order was created
                            from this bundle.
        readback_sha256     The consent read-back, against its published digest (spec EC-MER-6).
        preferences_sha256  The preferences block, against its published digest (spec EC-MER-6).
        canonical_form      Every key is reversed and the digest recomputed. A digest that moved would mean
                            the file could not be reproduced by anyone using a different JSON writer.
        required_members    EC-MER-6 makes the read-back and the preferences hash REQUIRED, so that a
                            merchant who omits the part that hurts them is caught rather than rewarded.
        gate_record_shape   The Gate decision record parses and carries all ten signed fields.

    Phase 2 — binding (hashlib only, no dependencies)
        checkout_binding    The agent's L3b commits to a checkout_hash; the price lock in the bundle must be
                            the one that hash is for. Without this, a valid signature over a DIFFERENT cart
                            would look identical.
        readback_binding    The read-back text on file is the one whose digest was published.

    Phase 3 — signatures (needs the pinned Verifiable Intent library)
        chain               verify_chain() over L1/L2/L3a/L3b.
        constraints         check_constraints(STRICT) over the constraints the L2 discloses.
        checkout_jwt        The merchant's ES256 signature over the price lock.
        gate_decision       Countersign's own Ed25519 signature on the decision record.

EXIT CODES
    0   Every check that could run passed. Warnings and skips are printed and do not change this.
    1   At least one integrity, binding or signature check FAILED. The failing check is named on stdout.
    2   The script could not run at all (no bundle file, unreadable JSON).

AN EXPIRED MANDATE IS NOT A TAMPERED ONE
    The pinned library's verify_chain() reads time.time() internally and exposes no clock override
    (docs/DECISIONS.md D-009), so a mandate whose ttl_seconds has elapsed reports an expiry error forever,
    including on a bundle nobody touched. Expiry is therefore reported as [WARN] and does not affect the
    exit code. A signature mismatch, a chain error or a missing member is [FAIL] and does.

MISSING LIBRARY
    If verifiable_intent is not importable, phases 1 and 2 still run and every tamper is still caught: both
    digests cover the whole document. Phase 3 is reported as [SKIP] with the reason, loudly — this script
    does not quietly narrow its own scope.

THIS FILE IS GENERATED, NOT HAND-WRITTEN
    Its constants come from the packet row, and regenerating it for an untampered bundle reproduces it byte
    for byte. The constants at the top are therefore the audit trail: if a digest ever disagreed with the
    document, that is where you would look first.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from typing import Any
`

const BODY = `

PASSED: list[str] = []
FAILED: list[str] = []
WARNED: list[str] = []
SKIPPED: list[str] = []


def ok(name: str, detail: str) -> None:
    PASSED.append(name)
    print("[PASS] %-22s %s" % (name, detail))


def fail(name: str, detail: str) -> None:
    FAILED.append(name)
    print("[FAIL] %-22s %s" % (name, detail))


def warn(name: str, detail: str) -> None:
    WARNED.append(name)
    print("[WARN] %-22s %s" % (name, detail))


def skip(name: str, detail: str) -> None:
    SKIPPED.append(name)
    print("[SKIP] %-22s %s" % (name, detail))


def expect(cond: bool, name: str, good: str, bad: str) -> bool:  # noqa: FBT001
    if cond:
        ok(name, good)
        return True
    fail(name, bad)
    return False


# ---------------------------------------------------------------------------------------------
# Canonicalisation: RFC 8785 (JCS), restricted to the value types a bundle may contain.
#
# Hand-rolled rather than json.dumps(sort_keys=True) because sort_keys sorts only the keys it is
# handed: RFC 8785 requires sorting at EVERY level, including objects nested inside arrays. The
# no-insignificant-whitespace half comes from separators=(",", ":").
#
# Floats are REFUSED, not formatted. A float would make the digest depend on a formatting decision,
# and this system has none because money is integer minor units (spec EC-FX-6).
# ---------------------------------------------------------------------------------------------
class Unsupported(ValueError):
    """A value RFC 8785 would have to format as a number, which we refuse to guess at."""


def jcs(value: Any) -> bytes:  # noqa: ANN401 - RFC 8785 walks arbitrary JSON
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, int):
        return str(value).encode("ascii")
    if isinstance(value, float):
        raise Unsupported("float %r would need RFC 8785 number formatting" % (value,))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if isinstance(value, (list, tuple)):
        return b"[" + b",".join(jcs(v) for v in value) + b"]"
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise Unsupported("object key %r is not a string" % (key,))
        # RFC 8785 sorts by UTF-16 code unit. Bundle keys are ASCII by construction, where that is
        # identical to Python's code-point ordering.
        parts = [
            json.dumps(k, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b":" + jcs(value[k])
            for k in sorted(value)
        ]
        return b"{" + b",".join(parts) + b"}"
    raise Unsupported("unsupported type %s" % (type(value).__name__,))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def reverse_keys(value: Any) -> Any:  # noqa: ANN401
    """Every object's keys, reversed. Arrays keep their order — it is significant."""
    if isinstance(value, list):
        return [reverse_keys(v) for v in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key in reversed(list(value.keys())):
            out[key] = reverse_keys(value[key])
        return out
    return value


def jwt_payload(token: Any) -> dict[str, Any]:  # noqa: ANN401
    """A JWS/SD-JWT payload, decoded but NOT verified. Returns {} for anything unreadable."""
    if not isinstance(token, str) or not token:
        return {}
    base = token.split("~", 1)[0]
    parts = base.split(".")
    if len(parts) < 2:
        return {}
    try:
        decoded = json.loads(b64u_decode(parts[1]).decode("utf-8"))
    except Exception:  # noqa: BLE001 - a verifier must never crash on bad input
        return {}
    return decoded if isinstance(decoded, dict) else {}


def disclosure_digest(disclosure_b64: str) -> str:
    """A disclosure's digest, per the SD-JWT spec: the ASCII base64url string is hashed.

    Not the decoded bytes. An implementation that hashed the JSON would produce digests that match
    nothing, and every reference in the token would silently fail to resolve.
    """
    return b64u(hashlib.sha256(disclosure_b64.encode("ascii")).digest())


def resolve_token(token: Any) -> dict[str, Any]:  # noqa: ANN401
    """Decode an SD-JWT and substitute its {"...": digest} references.

    Necessary here, not optional: an L3's delegate_payload carries references, and the actual
    mandate.checkout.1 claim with its checkout_hash sits in the disclosure section. Reading the
    payload alone finds no 'vct' at all, so the binding check would report "the bundle has no L3b
    committing to a checkout_hash" for every untampered packet.

    Substitution is not verification. The digests are matched and the values substituted; whether
    those values are covered by a signature is verify_chain's job in phase 3, and a reader who
    distrusts the substitution can redo it in ten lines.
    """
    payload = jwt_payload(token)
    if not isinstance(token, str) or not token or "~" not in token:
        return payload
    by_digest: dict[str, Any] = {}
    for raw in token.split("~", 1)[1].split("~"):
        if not raw:
            continue
        by_digest[disclosure_digest(raw)] = jwt_payload(raw + ".x") or _decode_disclosure(raw)
    return _substitute(payload, by_digest)


def _decode_disclosure(raw: str) -> Any:  # noqa: ANN401
    try:
        decoded = json.loads(b64u_decode(raw).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if isinstance(decoded, list) and decoded:
        return decoded[-1] if len(decoded) > 2 else (decoded[1] if len(decoded) == 2 else None)
    return decoded


def _substitute(node: Any, by_digest: dict[str, Any], depth: int = 0) -> Any:  # noqa: ANN401
    if depth > 8:
        return node
    if isinstance(node, dict) and "..." in node and len(node) == 1:
        # Left unresolved rather than dropped: a dropped reference would look like an absent claim,
        # and "absent" reads as "nothing to worry about".
        found = by_digest.get(node["..."])
        return _substitute(found, by_digest, depth + 1) if found is not None else node
    if isinstance(node, list):
        return [_substitute(entry, by_digest, depth + 1) for entry in node]
    if isinstance(node, dict):
        return {k: _substitute(v, by_digest, depth + 1) for k, v in node.items()}
    return node


# ---------------------------------------------------------------------------------------------
# Phase 1 — integrity. hashlib only: every field of the bundle is covered here.
# ---------------------------------------------------------------------------------------------
#: Every hashed member except l1. A bundle assembled before the buyer had a card credential has no
#: L1, and §7.3 marks it optional — so its absence must not read as a defect, while the absence of
#: any of these eight must.
REQUIRED_CORE = [m for m in ("v", "l2", "l3a", "l3b", "checkout_jwt", "gate_decision", "webauthn", "vi_lib_commit")]


def phase_one(doc: dict[str, Any]) -> None:  # noqa: ANN401
    bundle = doc.get("bundle")
    if not isinstance(bundle, dict):
        fail("bundle_present", "the document has no 'bundle' object")
        return
    ok("bundle_present", "%d top-level members" % len(bundle))

    try:
        canonical = jcs(bundle)
    except Unsupported as exc:
        fail("canonicalisable", "the bundle cannot be canonicalised: %s" % (exc,))
        return
    ok("canonicalisable", "%d bytes of RFC 8785 canonical JSON" % len(canonical))

    digest_hex = sha256_hex(canonical)
    digest_b64u = b64u(hashlib.sha256(canonical).digest())
    expect(
        digest_hex == PUBLISHED["PUBLISHED_BUNDLE_HASH_HEX"],
        "bundle_hash",
        "matches the published value %s" % digest_hex,
        "this bundle hashes to %s but Countersign published %s — something was changed after it was "
        "published" % (digest_hex, PUBLISHED["PUBLISHED_BUNDLE_HASH_HEX"]),
    )
    expect(
        digest_b64u == PUBLISHED["PUBLISHED_BUNDLE_HASH_B64URL"],
        "bundle_hash_b64url",
        "matches the value vi-service returns (base64url of the same digest)",
        "we compute %s and vi-service publishes %s"
        % (digest_b64u, PUBLISHED["PUBLISHED_BUNDLE_HASH_B64URL"]),
    )

    # D18: custom_id's preimage is the nine hashed members, NOT the whole bundle.
    core = {k: bundle[k] for k in PUBLISHED["HASHED_MEMBERS"] if k in bundle}
    absent_core = [m for m in REQUIRED_CORE if m not in core]
    expect(
        not absent_core,
        "core_members",
        "all %d required hashed members are present" % len(REQUIRED_CORE),
        "missing hashed member(s): %s" % absent_core,
    )
    if "l1" not in core:
        warn("core_members_l1", "no l1 in this bundle; the issuer credential is optional per §7.3")
    excluded_present = [k for k in PUBLISHED["EXCLUDED_FROM_CUSTOM_ID"] if k in core]
    expect(
        not excluded_present,
        "core_excludes",
        "paypal and shipments are correctly outside the custom_id preimage",
        "paypal/shipments must not be in the custom_id preimage; found %s" % excluded_present,
    )
    custom_id = "%s:%s" % (PUBLISHED["BUNDLE_VERSION"], b64u(hashlib.sha256(jcs(core)).digest()))
    if PUBLISHED["PUBLISHED_CUSTOM_ID"] is None:
        warn("custom_id", "the bundle does not declare version %s, so no custom_id can be recomputed"
             % PUBLISHED["BUNDLE_VERSION"])
    else:
        expect(
            custom_id == PUBLISHED["PUBLISHED_CUSTOM_ID"],
            "custom_id",
            "reproduces %s, the string PayPal's order record carries" % custom_id,
            "recomputes to %s but the packet publishes %s — either the chain was altered or this is not "
            "the bundle the order was created from" % (custom_id, PUBLISHED["PUBLISHED_CUSTOM_ID"]),
        )
        paypal = bundle.get("paypal")
        if isinstance(paypal, dict) and isinstance(paypal.get("custom_id"), str):
            expect(
                paypal["custom_id"] == custom_id,
                "paypal_custom_id",
                "paypal.custom_id agrees with the recomputation",
                "paypal.custom_id is %s but the core recomputes to %s" % (paypal["custom_id"], custom_id),
            )

    # EC-MER-6's two required hashes.
    for member in ("readback", "preferences"):
        published = PUBLISHED.get("PUBLISHED_%s_SHA256" % member.upper())
        if member not in bundle:
            fail(
                "%s_present" % member,
                "no '%s' member. Spec EC-MER-6 makes it REQUIRED so a merchant cannot win by omitting "
                "the part that hurts them." % member,
            )
            continue
        ok("%s_present" % member, "present")
        value = bundle[member]
        raw = jcs(value) if member == "preferences" else str(value).encode("utf-8")
        digest = sha256_hex(raw)
        if published is None:
            fail(
                "%s_sha256" % member,
                "the packet has a '%s' but no published digest, so nothing can be compared" % member,
            )
            continue
        expect(
            digest == published,
            "%s_sha256" % member,
            "matches the published digest %s" % digest,
            "the %s on file hashes to %s but the packet publishes %s — the text was changed after the "
            "hash was taken" % (member, digest, published),
        )

    # The canonical form must not depend on key order, or no third party could reproduce it.
    reordered_hex = sha256_hex(jcs(reverse_keys(bundle)))
    expect(
        reordered_hex == digest_hex,
        "canonical_form",
        "reversing every key leaves the digest unchanged, so any JSON writer reproduces it",
        "reversing the keys changed the digest (%s -> %s): the published hash cannot be reproduced by a "
        "third party" % (digest_hex, reordered_hex),
    )

    required = ("readback", "readback_sha256", "preferences_sha256")
    missing = [k for k in required if k not in bundle]
    expect(
        not missing,
        "required_members",
        "every EC-MER-6 required field is present",
        "missing required field(s): %s" % missing,
    )

    record = bundle.get("gate_decision")
    if not isinstance(record, str) or not record:
        skip("gate_record_shape", "the packet carries no Gate decision record")
    else:
        parts = record.split(".")
        if len(parts) != 3:
            fail("gate_record_shape", "the decision record is not a compact JWS (%d parts)" % len(parts))
        else:
            try:
                payload = json.loads(b64u_decode(parts[1]).decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                fail("gate_record_shape", "the decision record payload does not decode: %s" % (exc,))
            else:
                fields = (
                    "gdc", "att", "mdt", "amount", "currency",
                    "payee", "checks_hash", "chain_valid", "vi_commit", "iat",
                )
                absent = [f for f in fields if f not in payload]
                expect(
                    not absent,
                    "gate_record_shape",
                    "all %d signed fields are present" % len(fields),
                    "the decision record is missing signed field(s): %s" % absent,
                )


# ---------------------------------------------------------------------------------------------
# Phase 2 — binding. Also hashlib only.
# ---------------------------------------------------------------------------------------------
def _find_checkout_hash(node: Any, depth: int = 0) -> Any:  # noqa: ANN401
    if depth > 6:
        return None
    if isinstance(node, dict):
        if node.get("vct") == "mandate.checkout.1":
            value = node.get("checkout_hash")
            return value if isinstance(value, str) and value else None
        for value in node.values():
            found = _find_checkout_hash(value, depth + 1)
            if found is not None:
                return found
    elif isinstance(node, list):
        for entry in node:
            found = _find_checkout_hash(entry, depth + 1)
            if found is not None:
                return found
    return None


def phase_two(doc: dict[str, Any]) -> None:  # noqa: ANN401
    bundle = doc.get("bundle") or {}
    # Resolved, not merely decoded: the checkout mandate lives in L3b's disclosure section, behind a
    # {"...": digest} reference in delegate_payload.
    l3b = resolve_token(bundle.get("l3b"))
    jwt = jwt_payload(bundle.get("checkout_jwt"))

    # Recursive, because a key-bound L3 may nest its checkout mandate one level inside a
    # key-confirmation wrapper. A flat scan finds nothing on such a token and reports "commits to no
    # price lock", which is a false alarm rather than a finding.
    committed = _find_checkout_hash(l3b)

    if committed is None:
        skip("checkout_binding", "the bundle has no L3b committing to a checkout_hash")
    elif not jwt:
        fail("checkout_binding", "L3b commits to a price lock but the bundle carries no checkout JWT")
    else:
        from_jwt = jwt.get("checkout_hash")
        if from_jwt is None:
            ok(
                "checkout_binding",
                "L3b commits to checkout_hash %s and a price lock is present; the price lock's own "
                "signature is checked in phase 3" % str(committed)[:16],
            )
        elif from_jwt == committed:
            ok("checkout_binding", "L3b commits to the price lock in this bundle (%s)" % str(committed)[:16])
        else:
            fail(
                "checkout_binding",
                "L3b committed to %s but the price lock carries %s — the agent authorised a different cart"
                % (committed, from_jwt),
            )

    readback = bundle.get("readback")
    published = PUBLISHED.get("PUBLISHED_READBACK_SHA256")
    if isinstance(readback, str) and isinstance(published, str):
        expect(
            sha256_hex(readback.encode("utf-8")) == published,
            "readback_binding",
            "the read-back text on file is the one whose digest was published",
            "the read-back does not hash to its published digest",
        )


# ---------------------------------------------------------------------------------------------
# Phase 3 — signatures, via the pinned library.
# ---------------------------------------------------------------------------------------------
#: Substrings that make a failure about the clock rather than about the bytes. See the module
#: docstring: an expired mandate is not a tampered one.
EXPIRY_MARKERS = (
    "expired",
    "expiry",
    "not yet valid",
    "not_yet_valid",
    "outside the validity",
    "past its validity",
    "skew",
)


def is_expiry_only(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in EXPIRY_MARKERS)


def _cart_identifiers(payload: dict[str, Any]) -> tuple[Any, Any]:  # noqa: ANN401
    """The merchant id and the first SKU in the price lock's cart, wherever the merchant sits."""
    cart = payload.get("cart") or {}
    merchant = (cart.get("merchant") or payload.get("merchant") or {})
    items = cart.get("items") or []
    first_sku = items[0].get("sku") if items and isinstance(items[0], dict) else None
    return merchant.get("id"), first_sku


def _locate_l2_disclosures(l2_serialized: str) -> tuple[str, str, str | None, str | None] | None:
    """The four disclosures an autonomous L2 is built from.

    Mirrors vi_service/l2.py::find_disclosures. create_layer2_autonomous emits one disclosure per
    merchant, one per acceptable item, then the open checkout mandate, then the open payment
    mandate, and the L3 sd_hashes are taken over presentations of those. Identification is by the
    disclosed *shape* (a 'vct' for the mandates, the merchant/item key sets for the other two), not
    by position, because position is an implementation detail of issuance order.

    Returns None when a mandate is missing, which means the chain is not an autonomous mandate and
    the caller must not fabricate a presentation.
    """
    try:
        from verifiable_intent.crypto.sd_jwt import decode_sd_jwt
    except Exception:  # noqa: BLE001
        return None

    try:
        parsed = decode_sd_jwt(l2_serialized)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("the L2 does not decode: %s" % (exc,)) from exc

    checkout_mandate = payment_mandate = None
    merchant = item = None
    for raw, value in zip(parsed.disclosures, parsed.disclosure_values):
        disclosed = value[-1] if isinstance(value, list) and value else value
        if not isinstance(disclosed, dict):
            continue
        vct = disclosed.get("vct")
        if vct == "mandate.checkout.open.1" and checkout_mandate is None:
            checkout_mandate = raw
            continue
        if vct == "mandate.payment.open.1" and payment_mandate is None:
            payment_mandate = raw
            continue
        if {"id", "name", "website"} <= disclosed.keys() and merchant is None:
            merchant = raw
            continue
        if {"id", "title"} <= disclosed.keys() and item is None:
            item = raw

    if checkout_mandate is None or payment_mandate is None:
        return None
    return checkout_mandate, payment_mandate, merchant, item


def ec_public_from_jwk(jwk: Any) -> Any:  # noqa: ANN401
    if not isinstance(jwk, dict):
        return None
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        return ec.EllipticCurvePublicNumbers(
            int.from_bytes(b64u_decode(jwk["x"]), "big"),
            int.from_bytes(b64u_decode(jwk["y"]), "big"),
            ec.SECP256R1(),
        ).public_key()
    except Exception:  # noqa: BLE001
        return None


def phase_three(doc: dict[str, Any]) -> None:  # noqa: ANN401
    bundle = doc.get("bundle") or {}
    try:
        from verifiable_intent.crypto.sd_jwt import decode_sd_jwt
        from verifiable_intent.verification.chain import verify_chain
    except Exception as exc:  # noqa: BLE001 - the import failing IS the interesting case
        skip(
            "chain",
            "the pinned verifiable_intent library is not importable (%s). Phases 1 and 2 still ran, and "
            "they cover every field of the bundle. Install it to run this phase." % (exc,),
        )
        return

    l1_raw, l2_raw = bundle.get("l1"), bundle.get("l2")
    l3a_raw, l3b_raw = bundle.get("l3a"), bundle.get("l3b")
    if not isinstance(l1_raw, str) or not isinstance(l2_raw, str):
        fail("chain", "the bundle carries no L1/L2 pair, so there is no chain to verify")
        return

    try:
        l1, l2 = decode_sd_jwt(l1_raw), decode_sd_jwt(l2_raw)
        l3a = decode_sd_jwt(l3a_raw) if isinstance(l3a_raw, str) and l3a_raw else None
        l3b = decode_sd_jwt(l3b_raw) if isinstance(l3b_raw, str) and l3b_raw else None
    except Exception as exc:  # noqa: BLE001
        fail("chain", "the tokens do not decode: %s" % (exc,))
        return

    issuer_public = ec_public_from_jwk(PUBLISHED.get("ISSUER_JWK"))
    if issuer_public is None:
        skip(
            "chain",
            "no ISSUER public key is embedded, so the L1 signature cannot be checked offline. Every "
            "digest check in phases 1 and 2 still applies.",
        )
        return

    # The L3 sd_hashes are computed over *selective presentations* of the L2, not over the whole L2.
    # The merchant sees the checkout mandate plus the item it ships; the network sees the payment
    # mandate plus the payee it settles to. verify_chain therefore needs those two presentations
    # reconstructed from the L2's own disclosures, which is what this does — the same reconstruction
    # apps/vi performs in vi_service/l2.py::find_disclosures. Without it, every real chain reports
    # "L3a (payment) sd_hash does not match L2 serialized form", which is a false alarm and the reason
    # an earlier version of this script failed on an untampered bundle.
    checkout_raw_token = bundle.get("checkout_jwt")
    merchant_id, item_id = _cart_identifiers(jwt_payload(checkout_raw_token))
    try:
        from verifiable_intent.crypto.disclosure import build_selective_presentation

        checkout_presentation = payment_presentation = None
        if isinstance(l2_raw, str) and l2_raw:
            located = _locate_l2_disclosures(l2_raw)
            if located is not None:
                base = l2_raw.split("~", 1)[0]
                checkout_mandate, payment_mandate, merchant, item = located
                checkout_presentation = build_selective_presentation(
                    base, [checkout_mandate, item or merchant]
                )
                payment_presentation = build_selective_presentation(base, [payment_mandate, merchant])
    except Exception as exc:  # noqa: BLE001
        skip("chain_presentations", "the L2 presentations could not be rebuilt (%s)" % (exc,))
        checkout_presentation = payment_presentation = None

    try:
        result = verify_chain(
            l1,
            l2,
            l3_payment=l3a,
            l3_checkout=l3b,
            issuer_public_key=issuer_public,
            clock_skew_seconds=300,
            l1_serialized=l1_raw,
            l2_serialized=l2_raw,
            l2_payment_serialized=payment_presentation,
            l2_checkout_serialized=checkout_presentation,
        )
    except Exception as exc:  # noqa: BLE001 - a verifier must never crash on adversarial input
        message = "verify_chain raised %s: %s" % (type(exc).__name__, exc)
        if is_expiry_only(message):
            warn("chain", message)
        else:
            fail("chain", message)
        return

    errors = [str(e) for e in (getattr(result, "errors", None) or [])]
    performed = len(getattr(result, "checks_performed", None) or [])
    skipped_by_lib = list(getattr(result, "checks_skipped", None) or [])
    if getattr(result, "valid", False):
        ok("chain", "verify_chain reports the chain VALID (%d checks performed)" % performed)
    elif errors and all(is_expiry_only(e) for e in errors):
        warn(
            "chain",
            "the signatures hold but the chain is outside its validity window at today's date: %s"
            % "; ".join(errors),
        )
    else:
        fail("chain", "verify_chain reports the chain INVALID: %s" % "; ".join(errors))
    if skipped_by_lib:
        warn("chain_checks_skipped", "the library skipped: %s" % "; ".join(skipped_by_lib))

    # STRICT constraint checking, as spec §8.3 requires: an unknown constraint type is a violation,
    # not a shrug, because an unknown constraint is unbounded agent authority.
    phase_three_constraints(bundle, l2, l3a, checkout_raw_token)

    # The merchant's price lock, against the embedded MERCHANT key. Independent of verify_chain: the
    # merchant signed the cart, not the chain, and a reader checking "did this merchant agree to this
    # price" is asking about the merchant's signature specifically.
    phase_three_checkout_jwt(checkout_raw_token)

    # Countersign's own Ed25519 signature on the decision record — the one signature on this page that
    # we control, and therefore the one a sceptical reader should check first.
    phase_three_gate_decision(bundle.get("gate_decision"))


def phase_three_checkout_jwt(checkout_raw: Any) -> None:  # noqa: ANN401
    if not isinstance(checkout_raw, str) or not checkout_raw:
        skip("checkout_jwt", "the bundle carries no price lock")
        return
    if ec_public_from_jwk(PUBLISHED.get("MERCHANT_JWK")) is None:
        skip("checkout_jwt", "no MERCHANT public key is embedded, so its signature cannot be checked")
        return
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec as _ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

        header = json.loads(b64u_decode(checkout_raw.split(".")[0]).decode("utf-8"))
        signing_input, signature_b64 = checkout_raw.rsplit(".", 1)
        raw_signature = b64u_decode(signature_b64)
        # The price lock carries a raw 64-byte r||s signature (P1363), not DER — the same encoding the
        # browser device key produces, and the one the library expects. cryptography's verify() only
        # accepts DER, so the conversion is explicit. Note the import path: encode_dss_signature lives in
        # 'asymmetric.utils', NOT in 'asymmetric.ec' where it used to be re-exported, so reaching for
        # '_ec.utils' raises AttributeError and reports as a failed signature check.
        r = int.from_bytes(raw_signature[:32], "big")
        s = int.from_bytes(raw_signature[32:], "big")
        ec_public_from_jwk(PUBLISHED["MERCHANT_JWK"]).verify(
            encode_dss_signature(r, s),
            signing_input.encode("ascii"),
            _ec.ECDSA(hashes.SHA256()),
        )
    except ImportError:
        skip("checkout_jwt", "cryptography is not available, so the ES256 check was not run")
    except InvalidSignature:
        fail("checkout_jwt", "the merchant's ES256 signature over the price lock did not verify")
    except Exception as exc:  # noqa: BLE001
        message = "the price lock's ES256 signature could not be checked: %s" % (exc,)
        if is_expiry_only(message):
            warn("checkout_jwt", message)
        else:
            fail("checkout_jwt", message)
    else:
        ok("checkout_jwt", "the merchant's ES256 signature over the price lock is valid (kid %s)"
           % header.get("kid"))


def phase_three_gate_decision(record: Any) -> None:  # noqa: ANN401
    if not isinstance(record, str) or not record:
        skip("gate_decision", "the packet carries no Gate decision record")
        return
    gate_jwk = PUBLISHED.get("GATE_JWK")
    if not isinstance(gate_jwk, dict):
        skip("gate_decision", "no GATE public key is embedded, so Countersign's own signature cannot be checked")
        return
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

        signing_input, signature_b64 = record.rsplit(".", 1)
        Ed25519PublicKey.from_public_bytes(b64u_decode(gate_jwk["x"])).verify(
            b64u_decode(signature_b64), signing_input.encode("ascii")
        )
    except ImportError:
        skip("gate_decision", "cryptography is not available, so the Ed25519 check was not run")
    except InvalidSignature:
        fail("gate_decision", "Countersign's own Ed25519 signature on the decision record did not verify")
    except Exception as exc:  # noqa: BLE001
        fail("gate_decision", "the decision record could not be checked: %s" % (exc,))
    else:
        ok("gate_decision", "Countersign's Ed25519 signature on the decision record is valid (kid %s)"
           % PUBLISHED.get("GATE_KID"))


#: Constraints the library appends to 'checked' while evaluating none of them. Its own source calls
#: them "network-enforced", and spec D19 makes Countersign's Gate the enforcer. Reporting them as
#: checked would tell a reader their budget cap was honoured when nobody checked it.
NETWORK_ENFORCED = ("mandate.payment.budget", "mandate.payment.recurrence", "mandate.payment.agent_recurrence")


def phase_three_constraints(bundle: dict[str, Any], l2: Any, l3a: Any, checkout_raw: Any) -> None:  # noqa: ANN401
    """Evaluate the disclosed constraints against the L3's fulfilment, in STRICT mode.

    This mirrors apps/vi's '_constraints': the payment side is evaluated against the resolved L3a,
    the checkout side against the price lock's cart. Both need the library's disclosure-reference
    resolver, because 'allowed_merchants' and 'allowed_payees' are stored as {"...": digest}
    references and a checker given a reference instead of a dict would silently degrade to
    "skipped: no resolved payees" — a PASS on an unchecked constraint, which is worse than no answer.
    """
    try:
        from verifiable_intent.crypto.disclosure import hash_disclosure
        from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures
        from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints
    except Exception as exc:  # noqa: BLE001
        skip("constraints", "the constraint checker is not importable (%s)" % (exc,))
        return

    try:
        claims = resolve_disclosures(l2)
    except Exception as exc:  # noqa: BLE001
        skip("constraints", "the L2's disclosures did not resolve (%s)" % (exc,))
        return

    by_hash: dict[str, Any] = {}
    try:
        for raw, value in zip(decode_sd_jwt(bundle["l2"]).disclosures,
                              decode_sd_jwt(bundle["l2"]).disclosure_values):
            by_hash[hash_disclosure(raw)] = value[-1] if isinstance(value, list) and value else value
    except Exception:  # noqa: BLE001
        by_hash = {}

    def resolve_refs(node: Any) -> Any:  # noqa: ANN401
        if isinstance(node, dict) and "..." in node:
            return by_hash.get(node["..."], node)
        if isinstance(node, list):
            return [resolve_refs(entry) for entry in node]
        if isinstance(node, dict):
            return {k: resolve_refs(v) for k, v in node.items()}
        return node

    def find_vct(vcts: tuple[str, ...]) -> dict[str, Any] | None:
        for delegate in claims.get("delegate_payload") or []:
            if isinstance(delegate, dict) and delegate.get("vct") in vcts:
                return delegate
        return None

    payment = find_vct(("mandate.payment.open.1", "mandate.payment.1"))
    checkout = find_vct(("mandate.checkout.open.1", "mandate.checkout.1"))
    if payment is None and checkout is None:
        skip("constraints", "the L2 discloses no mandate, so there is nothing to evaluate")
        return

    payment_claims: dict[str, Any] = {}
    if l3a is not None:
        try:
            payment_claims = resolve_disclosures(l3a)
        except Exception:  # noqa: BLE001
            payment_claims = {}

    # The payment side's fulfilment is the L3a's own 'mandate.payment.1' disclosure — the amount, the
    # payee and the instrument it committed to — NOT the whole resolved payload. Passing the envelope
    # would leave 'payment_amount' absent one level down, and the checker answers "Missing or invalid
    # payment_amount in fulfillment": a false alarm on every real packet.
    payment_fulfilment: dict[str, Any] = {}
    for delegate in payment_claims.get("delegate_payload") or []:
        if isinstance(delegate, dict) and delegate.get("vct") == "mandate.payment.1":
            payment_fulfilment = delegate
            break

    side_reports: list[tuple[str, bool, list[str]]] = []
    for side, mandate, fulfilment in (
        ("payment", payment, payment_fulfilment),
        ("checkout", checkout, _checkout_fulfilment(checkout_raw)),
    ):
        if mandate is None:
            side_reports.append((side, False, ["no %s mandate was disclosed in the L2" % side]))
            continue
        constraints = [c for c in resolve_refs(mandate.get("constraints") or []) if isinstance(c, dict)]
        if not constraints:
            side_reports.append((side, False, ["no %s constraints were disclosed, so none could be enforced" % side]))
            continue
        try:
            report = check_constraints(constraints, fulfilment, mode=StrictnessMode.STRICT)
        except Exception as exc:  # noqa: BLE001
            side_reports.append((side, False, ["%s raised %s: %s" % (side, type(exc).__name__, exc)]))
            continue
        violations = [str(v) for v in (getattr(report, "violations", None) or [])]
        checked = [str(c) for c in (getattr(report, "checked", None) or [])]
        # The three network-enforced types are moved to "not checked here" rather than counted as
        # satisfied, which is spec D19 restated for a reader with no Gate in front of them.
        owed = [c for c in checked if c in NETWORK_ENFORCED]
        summary = "%d checked, %d violated%s" % (
            len(checked) - len(owed),
            len(violations),
            (", %d not evaluated by the library (spec D19 — Countersign's Gate enforces those)"
             % len(owed)) if owed else "",
        )
        side_reports.append((side, bool(getattr(report, "satisfied", False)) and not violations,
                             violations + [summary]))

    satisfied = all(ok_flag for _, ok_flag, _ in side_reports)
    detail = "; ".join("%s: %s" % (side, "; ".join(notes)) for side, _, notes in side_reports)
    if satisfied:
        ok("constraints", "strict mode — " + detail)
    else:
        fail("constraints", "strict mode — " + detail)


def _checkout_fulfilment(checkout_raw: Any) -> dict[str, Any]:  # noqa: ANN401
    """The checkout side's fulfilment context, built from the price lock the bundle carries."""
    payload = jwt_payload(checkout_raw)
    cart = payload.get("cart") or {}
    items = cart.get("items") or []
    # The cart's quantity member is 'quantity', not 'qty' - checkout_jwt.py emits
    # {"sku", "title", "quantity", "unit_minor"}. Reading the wrong one yields quantity=None and the
    # checker reports "Invalid quantity for item SKU-…: None", which is a false alarm on a real packet.
    return {
        "merchant": cart.get("merchant") or payload.get("merchant") or {},
        "line_items": [
            {"id": i.get("sku"), "quantity": i.get("quantity")} for i in items if isinstance(i, dict)
        ],
        "checkout_jwt": checkout_raw,
    }


# ---------------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------------
def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        print("usage: python verify.py <bundle.json>")
        return 2
    path = argv[1]
    if not os.path.isfile(path):
        print("[FAIL] %-22s %s is not a file" % ("bundle_readable", path))
        return 2
    try:
        with open(path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        print("[FAIL] %-22s %s could not be parsed: %s" % ("bundle_readable", path, exc))
        return 2
    if not isinstance(doc, dict):
        print("[FAIL] %-22s the file's top level is not a JSON object" % ("bundle_readable",))
        return 2

    print("Countersign offline verifier — packet %s" % PUBLISHED.get("PACKET_ID"))
    print("Canonicalisation: RFC 8785 (JCS) + SHA-256. No network is used at any point.")
    print("")
    print("Phase 1 — integrity")
    phase_one(doc)
    print("")
    print("Phase 2 — binding")
    phase_two(doc)
    print("")
    print("Phase 3 — signatures (pinned Verifiable Intent library)")
    phase_three(doc)
    print("")
    print("-" * 78)
    print(
        "%d passed, %d failed, %d warnings, %d skipped"
        % (len(PASSED), len(FAILED), len(WARNED), len(SKIPPED))
    )
    if FAILED:
        print("FAILED checks: %s" % ", ".join(FAILED))
        print("")
        print("A failed integrity or binding check means this file is not the one Countersign published,")
        print("or that Countersign published something inconsistent. Either way, do not rely on it.")
        return 1
    if WARNED:
        print("Warnings (do not change the exit code): %s" % ", ".join(WARNED))
    if SKIPPED:
        print("Skipped (not run here): %s" % ", ".join(SKIPPED))
    print("")
    print("RESULT: the document is internally consistent with every digest Countersign published.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
`
