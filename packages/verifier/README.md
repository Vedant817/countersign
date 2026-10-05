# `@countersign/verifier` — the public verifier (spec §8.18, S-20, WP-18)

Every evidence packet's PDF carries a QR code pointing at `/v/{packetId}`. A PayPal adjudicator or a
chargeback analyst scans it and re-verifies the chain **without trusting us**. This package is what that page is
made of, and the downloaded script a reader runs when they do not trust us at all.

> **The property to protect: a reader who does not trust us must still get a true answer.**

Everything below follows from that sentence. It is also §18 judge question 47 — _"show me a way to verify your
claims independently"_ — and the answer is this page plus the file it serves.

---

## The five source files

| File             | Owns                                                                                                    | The trap it exists to avoid                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle.ts`      | RFC 8785 canonicalisation, both digests, SD-JWT decode + resolve, the **raw download** document         | Two implementations of JCS would be two digests for one document, and the hash's whole purpose is that a third party reproduces ours. |
| `redact.ts`      | the **redacted page** document, `maskEmail`/`maskOpaqueId`, `assertRedactionHolds`                      | "Redacted" that is only hidden by CSS leaves the raw L1 in the page's JSON, and view-source prints it.                                |
| `verify-view.ts` | the twelve offline checks, the live checks, the report model, `publicPacketUrl`, **AT-M18.2's** limiter | A single green tick would have to hide D-009 (no as-of clock) and D19 (three constraints nobody evaluates).                           |
| `verify-py.ts`   | the generated offline `verify.py`                                                                       | A code block is not evidence, and a script with no embedded digest proves nothing.                                                    |
| `types.ts`       | the closed ports and the report types                                                                   | —                                                                                                                                     |

---

## Canonicalisation, stated once

Both digests are taken over the **RFC 8785 (JCS)** canonical form of a JSON value:

- object keys sorted by UTF-16 code unit at **every** level (including inside arrays),
- no insignificant whitespace (`,` and `:` only),
- `undefined` dropped rather than serialised as `null`,
- **no floats** — refused, not formatted. A float would make the digest depend on a formatting decision, and
  this system has none because money is integer minor units (EC-FX-6).

The serialiser is **`canonicalJson` from `@countersign/db`**, not a local copy. `packages/orders` derives
`custom_id` with it, `packages/defender` derives `evidence_packets.bundle_hash` with it, and `apps/vi`
reimplements the same rules in Python. Two implementations of JCS would be two digests for one document.

### Key-reordering stability

`test/bundle.test.ts` reverses every key at every level and asserts the digest is unchanged — for
`bundle_hash`, for `custom_id`, and across a `JSON.parse`/`stringify` round trip. It also asserts the digest
_does_ move when a value changes, so the stability tests cannot pass vacuously.

### The two digests, which are not the same digest

| Digest                         | Preimage                                                       | Encoding      | Written by                                        | Checked by            |
| ------------------------------ | -------------------------------------------------------------- | ------------- | ------------------------------------------------- | --------------------- |
| `evidence_packets.bundle_hash` | the **whole** stored bundle                                    | **hex**       | `packages/defender`                               | this page             |
| `custom_id`'s payload          | the **nine-member core** (§7.3 minus `paypal` and `shipments`) | **base64url** | `packages/orders`, into PayPal's own order record | this page, and PayPal |

`paypal` and `shipments` are excluded from `custom_id` because they are written _after_ the order exists
(§7.3). So a shipment edit moves `bundle_hash` and must leave `custom_id` alone — asserted in both test files,
because that asymmetry is easy to get backwards and a hash that moved on every parcel scan could not be the
value in an order created before shipping.

**A cross-service divergence, reported rather than hidden:** `apps/vi` returns `bundle_hash` in **base64url**
while `evidence_packets.bundle_hash` is **hex**. Same 32 bytes, different encoding. `liveChecks` compares them
by decoding (`base64UrlToHex`), so the two services cannot silently disagree about the digest.

---

## EC-PRIV-3: the redacted view and the raw download are two documents

|                | `buildRedactedPacketDocument` | `buildRawBundleDocument`             |
| -------------- | ----------------------------- | ------------------------------------ |
| module         | `redact.ts`                   | `bundle.ts`                          |
| raw L1/L2/L3   | **no**                        | yes, byte for byte                   |
| buyer email    | only as `a***@domain`         | only if the L1 discloses it          |
| street address | **never**                     | as disclosed                         |
| served by      | `app/v/[packetId]/page.tsx`   | `app/v/[packetId]/download/route.ts` |

They share no code, no object and no field. `test/redact.test.ts` asserts the separation **in both
directions**: nothing raw in the page's serialised bytes, and nothing redacted-and-lossy in the download.

### The redaction is applied to what is _served_, and re-checked before serving

`assertRedactionHolds(redacted, bundle)` is exported and called by the page route on **every render**. It runs
two independent sweeps over the **serialised** bytes:

1. **Literal sweep** — the raw tokens, the email, the `payer_id` and the street values must not appear. Catches
   the classic "the L1 is in the page's JSON" bug.
2. **Pattern sweep** — no email-shaped string may appear at all. Catches the case nobody planned for: a new
   member added to the builder that quotes the buyer's address from somewhere else.

It returns `err(CS_INTERNAL)` naming what leaked, and the page refuses to render. A redaction policy enforced
only by the discipline of whoever writes the next field is not a policy.

### What the raw download legitimately contains

EC-PRIV-3 accepts the raw tokens _because_ SD-JWT selectively discloses: the captured L1 carries exactly one
disclosure, `email`, and the fixture asserts that from the decoded token rather than from a database column. So
the download is bounded by the **token format** rather than by a filter we wrote — `verify_chain` enforces it,
not us.

---

## EC-MER-6: the read-back and preferences are required fields

The bundle carries `readback`, `readback_sha256`, `preferences` and `preferences_sha256`. Their presence is
**required**, so a merchant who omits the part that hurts them is caught by the verifier rather than rewarded:

- omitting `readback` fails `readback_hash` **and** `required_members`,
- editing it fails `readback_hash`,
- removing `preferences_sha256` fails `preferences_hash` ("an unhashed field is an unauditable one").

The preferences digest is taken over `canonicalJson(preferences)`, so `{}` hashes as `{}` rather than as the
empty string. Getting that wrong would make every packet with no preferences fail its own check — the sort of
false alarm that teaches readers to ignore the page.

---

## The per-check model

Every check is a **row**, never a summary line, because §8.18 asks for the per-check result and a reader who
cannot see _which_ check failed cannot judge whether the failure matters.

```
PASS     the check ran and agreed
FAIL     the check ran and disagreed — the interesting case
WARN     the check could not be conclusive, and we say why
SKIPPED  the check needs material this packet does not carry — named, never silent
```

**Absent is never the same as passing.** `apps/vi` makes the same call for the same reason: an empty constraint
list is `satisfied: false` — "nothing to check" is not "checked".

### The twelve offline checks

| id                  | category  | what it detects                                                           |
| ------------------- | --------- | ------------------------------------------------------------------------- |
| `bundle_hash`       | integrity | any edit to any member; the published digest vs a recomputation           |
| `custom_id`         | integrity | a core that no longer reproduces PayPal's `custom_id` (D18)               |
| `readback_hash`     | integrity | an edited consent read-back (EC-MER-6)                                    |
| `preferences_hash`  | integrity | an edited preferences block (EC-MER-6)                                    |
| `key_order`         | integrity | a canonical form that is _not_ order-independent                          |
| `required_members`  | schema    | EC-MER-6's anti-omission half                                             |
| `custom_id_binding` | binding   | `paypal.custom_id` disagreeing with the recomputation (D-018)             |
| `checkout_binding`  | binding   | a price lock that is not the one L3b committed to (AT-M3.7)               |
| `gate_record`       | signature | **our own** Ed25519 signature on the decision record, against `jwks_keys` |
| `vi_lib_commit`     | schema    | a packet verified against another library version                         |
| `l1_disclosures`    | schema    | what the L1 actually discloses (EC-PRIV-3's boundary)                     |

Plus, from `POST /v1/public/verify`: `chain_valid`, one row per `checks_performed`, one **WARN** per
`checks_skipped`, `constraints`, `network_enforced` (D19), `vi_bundle_hash`, `at_time` (EC-TIME-3), `vi_keys`.

### `checkout_binding` resolves the L3b, it does not merely decode it

`delegate_payload` carries `{"...": digest}` references and the `mandate.checkout.1` claim with its
`checkout_hash` lives in the **disclosure section**. Reading the payload alone finds no `vct` at all, which
would make the page report "commits to no price lock" for every untampered packet — a false alarm on the one
page nobody may cry wolf on. `resolveSdJwt` matches digests the way the SD-JWT spec defines them (the **ASCII
base64url string** is hashed, not the decoded bytes) and substitutes recursively, leaving unresolvable
references in place rather than dropping them.

The walk is recursive for the same reason: a key-bound L3 may nest its checkout mandate inside a
key-confirmation wrapper, and a flat scan finds nothing.

---

## D-009 and EC-TIME-3: `at_time_not_honoured` is a banner

The pinned library's `verify_chain` reads `time.time()` internally and exposes no clock override, so an as-of
verdict is impossible. `apps/vi` returns `at_time_not_honoured: true` with the reason rather than fabricating
one.

- `atTimeWarningOf` extracts the reason **verbatim**, because the Defender cites this string in an evidence
  packet.
- The page renders it as the **first line of the response**, above every check row, with a `WARN` row beside it.
- `chain_valid` may still be `PASS` — and that is the point. A pass **plus** a stated limitation is honest; a
  pass with the limitation hidden is not, because it lends false confidence to exactly the reader the page
  exists to reassure.
- `requestLiveVerify` deliberately sends **no** `at_time`: asking for a verdict we cannot honour would turn an
  honest limitation into a silent one.

The page's own phrasing — "this is a live re-verification, and the service could not answer as of capture time"
— is the claim; D-009 is why it is worded that way.

---

## AT-M18.2: the rate limit

`createPublicRateLimiter` is a **sliding** window, mirroring `apps/vi`'s `RateLimiter` exactly.

- 30 requests / 60 s / IP (`PUBLIC_RATE_LIMIT_PER_MIN`, `PUBLIC_RATE_WINDOW_MS`).
- Sliding, not fixed: a fixed window permits 30 requests at t=0.1 s and 30 more at t=59.9 s — sixty ES256 chain
  verifications against a budget of thirty. `test/rate-limit.test.ts` spreads the requests and asserts the
  budget returns **one slot at a time**.
- A **rejected request is not recorded**, so hammering does not push the caller's own window further out.
- `clientIdFromHeaders` bills only the **first** `X-Forwarded-For` hop — a forged suffix would otherwise mint an
  unlimited budget.
- `maxClients` bounds the map, because an unbounded one keyed by a spoofable header is a memory-exhaustion
  vector.
- `CS_RATE_LIMITED`, not `PP_RATE_LIMITED` (D-007): the latter means _PayPal_ is throttling us and its
  buyer-facing copy says exactly that, which would be a lie here.
- Injected `nowMs`, so a 60-second window is tested by moving a number rather than by sleeping.

**Why a second limiter, when `apps/vi` already has one:** a limit behind the thing it protects can be bypassed
by the thing in front of it. Without this, "Verify now" is an unmetered Next route forwarding to a metered
service — the limiter still caps vi's crypto per IP, but our process absorbs everything in the meantime.

---

## `verify.py` — the offline verifier

**Generated as a real file**, served as `text/x-python` with `Content-Disposition: attachment` from
`/v/{packetId}/download?as=verify.py`. One route for both artifacts, selected by a query parameter, because the
script embeds the digests of the bundle it checks — serving one without the other hands a reader something
unusable.

### Three phases

| Phase         | Needs              | Affects the exit code                  |
| ------------- | ------------------ | -------------------------------------- |
| 1. Integrity  | `hashlib` only     | **yes**                                |
| 2. Binding    | `hashlib` only     | **yes**                                |
| 3. Signatures | the pinned library | yes — but expiry is `WARN`, not `FAIL` |

Phases 1–2 alone decide the exit code, because `custom_id` covers the nine hashed members and `bundle_hash`
covers the whole document: **editing any field changes at least one digest**, so a machine with no
`verifiable_intent` installed still detects every tamper.

Phase 3 additionally runs `verify_chain`, `check_constraints(STRICT)` over both sides, the merchant's ES256
signature on the price lock, and our own Ed25519 signature on the decision record.

### Four decisions in the generated source worth knowing

1. **Expiry is tolerated.** The pinned `verify_chain` has no clock override, so an expired mandate reports an
   expiry error _forever_ — including on a bundle nobody touched. Failing on it would be a permanent false alarm
   on every historical packet. Expiry-only → `[WARN]`; signature mismatch, chain error or a missing member →
   `[FAIL]`. The script states which rule it applied.
2. **Anything it could not do is a loud `[SKIP]`**, listed in the summary. A missing library, an unrecognised
   shape, an unpublished key. A verifier that quietly narrows its own scope is the failure mode this page exists
   to avoid.
3. **The L2 presentations are rebuilt.** The L3 `sd_hash`es are computed over _selective presentations_ of the
   L2, so `verify_chain` needs them reconstructed — the same job `vi_service/l2.py::find_disclosures` does.
   Without it every real chain reports `L3a (payment) sd_hash does not match L2 serialized form`.
4. **Floats are refused by the canonicaliser**, with a message naming RFC 8785 §3.2.2 number formatting.

### Determinism

`renderVerifyPy` takes no timestamp and no random id, so regenerating it for an untampered bundle reproduces it
**byte for byte**. A generated artefact that changed per request could not be diffed against a published copy,
which is the only way a reader would notice we regenerated it with different constants.

`pythonLiteral` is a hand-written Python serialiser rather than `JSON.stringify`: JSON `null` is a `NameError`
in Python, and a generated script that cannot be _imported_ is worth nothing. An earlier draft did exactly this
and died on line 104.

---

## AT-M18.1: tampering is shown, per field category

`test/verify.test.ts` (the page) and `test/verify-py.test.ts` (the script) both tamper per category, and both
assert **three** things per case — never just "an error came back":

1. the named check's status is `FAIL` (or `WARN`, where the semantics demand it),
2. the `detail` names the field and the reason, and
3. **the page's rendered output changes.**

Assertion 3 is the load-bearing one: a tamper the page renders without complaint is the failure mode this
acceptance test exists to prevent. The tests render the report (status word + label + detail per row) and
compare it against the untampered render.

**The cases re-hash the bundle**, because a tamperer who edits a field and re-publishes the digest can only be
caught by a check that inspects the field itself. Both paths are asserted.

| Category                                        | Caught by (page)                         | Caught by (script)   |
| ----------------------------------------------- | ---------------------------------------- | -------------------- |
| `l1`, `l2`, `l3a`, `l3b`, `checkout_jwt` bodies | `custom_id`                              | `paypal_custom_id`   |
| the same, without re-hashing                    | `bundle_hash`                            | `bundle_hash`        |
| `checkout_hash`                                 | `checkout_binding`                       | `checkout_binding`   |
| `custom_id` in `paypal`                         | `custom_id`                              | `paypal_custom_id`   |
| `readback`                                      | `readback_hash`                          | `readback_sha256`    |
| `preferences`                                   | `preferences_hash`                       | `preferences_sha256` |
| `readback` omitted                              | `readback_hash` + `required_members`     | `required_members`   |
| `preferences_sha256` removed                    | `preferences_hash`                       | —                    |
| `gate_decision`                                 | `custom_id` **and** `gate_record`        | `gate_decision`      |
| `bundle_hash` itself                            | `bundle_hash`                            | `bundle_hash`        |
| `shipments` (post-order)                        | `bundle_hash` only, **not** `custom_id`  | same                 |
| `vi_lib_commit` removed                         | `vi_lib_commit` → `SKIPPED`              | —                    |
| buyer PII                                       | `assertRedactionHolds` refuses to render | —                    |

Note the asymmetry in the token rows: once the digests are re-derived, `custom_id` **passes** (the document and
the published value agree) and `paypal_custom_id` **fails** — the bundle's own `custom_id` is the one PayPal's
order record holds. That is D-018's consistency check doing its job, and it is a stronger result than a
`custom_id` mismatch: it proves a re-hashed edit cannot survive contact with a value an outside party also has.

---

## The offline tests **run Python**

`test/verify-py.test.ts` writes `renderVerifyPy`'s output and a bundle to a temp directory and runs:

```
uv run --project apps/vi python verify.py bundle.json
```

There is **no stubbed interpreter** and no hand-written expectation about what it prints — assertions are on the
exit code and the stdout that actually came back. When `uv`, Python or `apps/vi/.venv` is absent the suite
**skips with a printed reason**; it never passes vacuously and never claims to have run something it did not.

### The fixture is a real capture

`test/fixtures/chain.json` was produced on **2026-10-05** by driving `apps/vi`'s own routes through
`fastapi.testclient` with a fixed clock — no sockets, no PayPal, no credentials. Every token in it was signed by
the real library at `356c29635f1c44df7de02edb58699ca9f29bece6`, and `vi_bundle_hash_reference` is the digest
`vi_service/verify.py::bundle_hash` itself produced.

That reference value is load-bearing: `test/bundle.test.ts` compares this package's TypeScript canonicaliser
against a Python one, which is the only real evidence that a third party can reproduce the digest.

The capture is a **JSON file rather than inlined constants** because an earlier draft inlined the tokens and
produced elided bodies (`"…ACHK6KF92"`) that decoded to nothing — while the tests still passed, because they
only asserted on shapes the truncated strings happened to satisfy. The cross-language digest comparison is the
assertion that would have caught it.

`paypal`, `shipments`, `buyer`, `readback` and `preferences` are shaped as `packages/defender` shapes them, with
made-up values. Every check here is a check on the **document**, so none of that needs to be real, and §8.0 rule
5's concern is about the **chain**, which is genuine throughout. The Gate key is a real Ed25519 key generated
per call, so `signDecisionRecord` → `verifyDecisionRecord` is a genuine round trip through `jose`.

---

## EC-DSP-9: an unknown packet is a 404 that says so

`loadVerifierPacket` returns `ok(undefined)` for an unknown id and **propagates a store fault**. That split is
deliberate: returning `undefined` for a database outage would render "we have no such packet" for what is
actually a fault, and a reader would conclude the evidence was withdrawn. The page maps `undefined` to `notFound()`
and an `err` to a 500.

A `packetId` that does not match `pkt_` + 26 Crockford characters cannot name a packet, so it takes the 404 path
— a real id to look for, rather than a query with a string in it.

---

## Accessibility (S-20)

- Server-rendered with **zero client JS**. "Verify now" is a `GET` to a route handler, so the page works with
  JavaScript disabled — which a sceptical reader testing our claims may well do.
- **The status is the word `PASS`/`FAIL`/`WARN`/`SKIPPED`**, not a colour and not an icon. A colour is invisible
  to a screen reader and to a colourblind reader, and this page is read by people debugging a payment dispute.
- `<table>` with `<th scope>` on both axes, and an `<caption>`.
- The banner and every failure are text in the document flow; nothing depends on hover.
- `escapeHtml` in the live route covers text and attribute context. Not a formality: `detail` strings embed
  attacker-influenced content (a tampered bundle's values, PayPal's error text), and without escaping a
  `<script>` in a read-back would execute on our origin — turning "download this and check it" into an XSS
  against the reader we are trying to reassure.

---

## Contract issues found in other packages (reported, not fixed — AGENTS.md rule 8)

1. **`publicPacketUrl` is not re-exported from `@countersign/defender`'s index.** It lives in
   `citation-check.ts`, and that package's `exports` map allows only `"."`. Its own documentation says one
   function for both the QR payload and the note URL is deliberate ("two implementations would eventually
   disagree — at which point a correct note is refused for a disallowed URL and a QR scans to a 404"). This
   package keeps a one-line mirror and `test/verify.test.ts` imports the original **by relative path** and
   asserts the two agree across a matrix of base URLs, so the drift risk is a failing test rather than a QR that
   scans to nothing. The right fix is one line in `defender/src/index.ts`.

2. **`packages/db` has no repository for `evidence_packets` or `jwks_keys`.** `packages/defender`'s _port_
   declares `packets.findById` and names the repository that should satisfy it, but `repos/` has no getter, and
   `jwks_keys` has no port member anywhere. The three routes in `apps/web/app/v/` read both tables directly,
   wrapped in the same `repo()` every other repository uses so the error typing is identical. The queries belong
   in `packages/db`: `findEvidencePacketById`, `findDisputeById` (this one exists) and `listJwksKeys`.

3. **`HASHED_MEMBERS` is re-declared rather than imported.** `packages/orders` exports
   `EVIDENCE_BUNDLE_HASHED_MEMBERS`, but `packages/orders` is not a dependency here and adding one is a
   `package.json` change this work package does not own (`packages/defender` declined it for the same reason).
   The duplication is _tested_, not trusted: `test/bundle.test.ts` asserts the list is exactly the nine §7.3
   names, in §7.3's order, and that no `PACKET_ONLY_MEMBERS` entry appears in it.

4. **`apps/vi` hashes in base64url, `evidence_packets.bundle_hash` is hex.** Same 32 bytes. Handled by decoding
   before comparison, but the two services should agree on an encoding so a reader comparing them by eye is not
   misled.

5. **`jwks.listAll()` has no repository**, and an adapter may satisfy it from `GET /v1/jwks` instead — legitimate,
   because the data is the same public data. Noted in `types.ts` so nobody treats the direct table read as the
   only option.

---

## Commands

```bash
pnpm --filter @countersign/verifier typecheck
pnpm --filter @countersign/verifier lint
pnpm --filter @countersign/verifier test
pnpm --filter @countersign/verifier build       # tsc -p tsconfig.build.json (declarations only)
```

Tests are offline by construction: no test opens a socket. The two that shell out to Python skip when `uv` or
`apps/vi/.venv` is absent.

## Exports

Full list in `src/index.ts`. The ones a caller needs:

```ts
// building
defineVerifierDeps(deps): VerifierDeps
loadVerifierPacket(deps, packetId): Promise<Result<LoadedPacket | undefined, CsError>>
buildVerifierReport(packet, deps, reported?): Promise<VerifierReport>
buildRedactedView(packet, deps): RedactedPacketDocument
assertRedactionHolds(redacted, bundle, extra?): Result<true, CsError>
requestLiveVerify(deps, packet): Promise<Result<PublicVerifyResponse, CsError>>

// canonicalisation
bundleHashHex(bundle): string          // evidence_packets.bundle_hash
bundleHashBase64Url(bundle): string    // what apps/vi returns
customIdForBundle(bundle): string | null
canonicalBundleCore(bundle): Record<string, unknown>
wireBundle(bundle): Record<string, unknown>   // every member vi declares, nulls included

// the two documents
buildRedactedPacketDocument(input): RedactedPacketDocument
buildRawBundleDocument(input): RawBundleDocument
renderVerifyPy(input): string

// rate limiting (AT-M18.2)
createPublicRateLimiter(options): PublicRateLimiter
clientIdFromHeaders(headers): string
rateLimitError(verdict, route): CsError

// URLs
publicPacketUrl(baseUrl, packetId): string
rawBundleUrl(baseUrl, packetId): string
verifyScriptUrl(baseUrl, packetId): string
```

`packages/verifier/src` is in `SCAN_ROOTS` of `scripts/check-money-discipline.mjs`: it carries
`disputes.amount_minor` on a public page, so it is as money-bearing as the packages that move it. Amounts cross
as `bigint` and are serialised as **strings** — `Number()` on a minor-unit amount is the exact float-money bug
that scan exists to catch (§0, EC-FX-6).
