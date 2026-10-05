# `@countersign/verifier` — the public verifier (spec §8.18, S-20, WP-18)

Every evidence packet's PDF carries a QR code pointing at `/v/{packetId}`. A PayPal adjudicator or a
chargeback analyst scans it and re-verifies the chain **without trusting us**. This package is what that page is
made of, and the downloaded script a reader runs when they do not trust us at all.

> **The property to protect: a reader who does not trust us must still get a true answer.**

Everything below follows from that sentence. It is also §18 judge question 47 — _"show me a way to verify your
claims independently"_ — and the answer is this page plus the file it serves.

---

## The six source files

| File             | Owns                                                                                                                                        | The trap it exists to avoid                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle.ts`      | RFC 8785 canonicalisation, both digests, SD-JWT decode + resolve, the **raw download** document                                             | Two implementations of JCS would be two digests for one document, and the hash's whole purpose is that a third party reproduces ours.               |
| `binding.ts`     | what the **signed** artefacts assert: the price lock's total and merchant, L3a's payee, the chain's `iat` window, the L2's spending ceiling | A digest is a function of the document, so it cannot bind the document. Only a signature the holder cannot produce can.                             |
| `redact.ts`      | the **redacted page** document, `maskEmail`/`maskOpaqueId`, `assertRedactionHolds`                                                          | "Redacted" that is only hidden by CSS leaves the raw L1 in the page's JSON, and view-source prints it.                                              |
| `verify-view.ts` | the offline checks, the live checks, the report model, `publicPacketUrl`, **AT-M18.2's** limiter                                            | A single green tick would have to hide D-009 (no as-of clock), D19 (three constraints nobody evaluates), **and which fields no signature reaches**. |
| `verify-py.ts`   | the generated offline `verify.py`                                                                                                           | A code block is not evidence, and a script with no embedded digest proves nothing.                                                                  |
| `types.ts`       | the closed ports and the report types                                                                                                       | —                                                                                                                                                   |

---

## The central promise, and where it was false

Every packet's PDF carries a QR pointing at `/v/{packetId]`, and the promise of that page is that **the page a
buyer reads is provably about _this_ purchase.** An adversarial audit (QA3-VENDOR-1) showed that promise was
false, and the failure was structural rather than a bug in one function:

- **`gateRecordCheck` verified the decision record's signature and never compared it to anything.** A genuinely
  Ed25519-signed `ALLOW` for a _different attempt, amount, currency and payee_ verified and the page reported
  every check passing. §3.1 I-1 is stated in terms of _this_ attempt, _this_ amount, _this_ currency, _this_
  payee, and nothing on the page compared any of the four.
- **`readback` is a `PACKET_ONLY_MEMBER`** (`bundle.ts`), so §7.3 excludes it from the `custom_id` preimage. Its
  only check was a self-hash — a digest published inside the document it covers, which the holder recomputes in
  one line. The read-back could be replaced with _"You may spend up to $9,999,999 at any merchant"_ and the page
  reported all-pass.
- **`paypal.order_id` / `capture_ids` are outside the `custom_id` preimage by design**, and `bundle_hash` is a
  digest of the bundle, so repointing `paypal` at another capture and recomputing both digests produced a
  document that is internally perfect.

The common cause: **every check was either a function of the document (a digest) or a self-consistency check
(a digest published inside the document).** Neither binds anything, and a substitution survives both. What binds
is a comparison against something the person rewriting the document cannot recompute, and there are only five of
those in §7.3: the issuer's L1 and L2, the agent's L3a and L3b, the merchant's price lock, and the Gate's own
signed record.

### What the record is now compared against, field by field

`gate_record` (the signature row) is unchanged in scope and now says so explicitly: it establishes that the
record **has not been edited**, and points at the rows that establish whether it is about this purchase. Eight
new rows do the comparing, **one per field, so a failure names the field**:

| row                     | compared against                                      | signature the anchor rests on        |
| ----------------------- | ----------------------------------------------------- | ------------------------------------ |
| `gate_record_amount`    | `checkout_jwt` → `cart.total.amount_minor`            | the **merchant** key (§8.3)          |
| `gate_record_currency`  | `checkout_jwt` → `cart.total.currency_code`           | the **merchant** key                 |
| `gate_record_payee`     | `checkout_jwt` → `merchant.id`, else L3a → `payee.id` | merchant key, else the **agent** key |
| `gate_record_chain`     | `chain_valid` vs §3.1 I-1's precondition              | the Gate's own signature             |
| `gate_record_vi_commit` | `bundle.vi_lib_commit`                                | the Gate's own signature             |
| `gate_record_iat`       | the `iat` window spanned by **all five** chain tokens | four independent issuers             |
| `gate_record_attempt`   | **nothing** — `WARN`                                  | —                                    |
| `gate_record_mandate`   | **nothing** — `WARN`                                  | —                                    |

`amount` is parsed with `fromPayPalValue`, the same function `packages/gate` writes it with, so the comparison
is in **integer minor units** and cannot round (§0, EC-FX-6). An amount that will not parse is a `FAIL`, not a
skip: a signed claim this page cannot read is an unchecked claim.

**Both directions of `iat` are checked**, and that is asserted rather than assumed. The pre-existing
`gate_record` row already reported `fresh: false` as a `WARN` when `iat` is far from `nowSec`, which covers
"older than expected". `gate_record_iat` compares against the **chain's own window** instead, so a record from
a _newer_ attempt is caught too — `test/binding.test.ts` and `test/verify-py.test.ts` each run both directions.

### How the packet substitution is caught

`paypal_dispute_binding` compares the bundle against **`disputes.capture_id` and `disputes.order_id`** — the row
this page is served _for_. That is a different table from the document, so it is the one anchor a holder of a
packet URL and write access to `evidence_packets.bundle` cannot reach. `loadVerifierPacket` already read that row
for the page's labels; two more members of the same read are all that was needed.

Both directions are checked (a wrong order, and a `capture_ids` list not **containing** the dispute's capture),
and both ids are **masked** in the message — §8.18 makes the packet id the page's only identifier, and a check
detail is rendered into the page, so naming them would reintroduce them in the one message written to help a
reader. A multi-capture order `PASS`es, because §7.2 legitimately allows sibling captures on one order.

### How the read-back is bound — and where it is not

| claim                                        | how it is established                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| not edited after `readback_sha256` was taken | `readback_hash`, unchanged, and EC-MER-6's anti-omission half still depends on it                        |
| **is the compiler's own rendering**          | `readback_rendered` — a `WARN`, §8.8's `readBack()` emits `**What you are authorising**` unconditionally |
| **grants no more than the signed mandate**   | `readback_cap_vs_mandate` — every money figure in the text, against the **largest cap in the signed L2** |
| **is the buyer's consent**                   | **cannot be established. `readback_binding` is a `WARN` on every packet.**                               |

The fourth row is the honest answer and it is stated on the page. There is no signature in §7.3's bundle that
commits to the read-back's words: it is a `mandates` column written after the mandate was signed, §7.3 excludes
it from the `custom_id` preimage, and `vi-client/src/types.ts:570` states that `prompt_summary` "is advisory and
is not covered by the signature". **No local change can manufacture a binding that does not exist in the signed
material**, so the page says "treat the read-back as unauthenticated" instead of printing a tick. See
[What cannot be bound to anything](#what-cannot-be-bound-to-anything) for the smallest real fix.

`readback_cap_vs_mandate` catches the audit's exact forgery — $9,999,999 is 499 850× the signed ceiling — and it
is **not** dependent on the attacker's wording: money is located by its **currency symbol**, which is how
`formatMoney` writes it, where the first version looked for the word `Spend` and the forged phrasing walked past
it. A figure this page **cannot read** is skipped rather than truncated, because a truncated figure is small
enough to pass a ceiling check (`₹9,99,999` is lakh-grouped; a permissive reader takes the `₹9` and reports
900 minor units).

### What cannot be bound to anything

Three fields are covered by **no signature in §7.3**, and both this package and the generated `verify.py` say
so on every packet. Each needs a change **outside `packages/verifier`** — reported here rather than fixed here
(AGENTS.md rule 8).

| field         | why nothing signed names it                                                                                             | the smallest real fix                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readback`    | a `mandates` column written after signing; a `PACKET_ONLY_MEMBER`, outside the `custom_id` preimage                     | add `readback_sha256` to §7.3's `custom_id` core **and** have `packages/orders` read it from `mandates.readback` when deriving `custom_id`. One column, two files, one hashing rule — and it binds because PayPal's own order record carries the result. |
| `preferences` | §8.8 states it is not a VI constraint and is not signed                                                                 | same change, or accept it: a preference does not bound authority, so a substituted one misleads a human rather than an agent.                                                                                                                            |
| `att` / `mdt` | the L1's `sub` is the user, the L2 names no mandate, the L3s name no attempt, the price lock names only a `checkout_id` | add `att` to the merchant-signed price lock claims (`apps/vi`'s `checkout_jwt.py` already receives the attempt id), **or** carry it in the L3a. Either makes `gate_record_attempt` a real check.                                                         |

The `readback` fix is the important one, and it is worth being precise about why the obvious version does not
work: **moving `readback` into `HASHED_MEMBERS` inside this package would break D18.** `custom_id` is derived at
order-creation time, when `readback` does not exist yet on the `OrderDraft`, and PayPal's order record already
carries a `custom_id` computed without it. Changing only the verifier's list would make the recomputed
`custom_id` disagree with the one PayPal holds on **every existing packet**. The change has to start at
`packages/orders`.

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

### Anti-omission holds. Anti-substitution needed a signature.

The two halves of EC-MER-6 have different strengths, and conflating them is what let the audit's forgery
through. `test/binding.test.ts` asserts both, and also asserts the **negative** — that a substitution the design
cannot catch is _not_ reported as caught:

| half                  | what it detects                                            | strength                                                                                           |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **anti-omission**     | the field is missing                                       | **holds.** `required_members` fails; three separate tests, one per deleted member                  |
| **anti-substitution** | the field is replaced with something internally consistent | **cannot hold without a signature.** `readback_cap_vs_mandate` is a ceiling, not an authentication |

A forger who writes a _smaller_ invented allowance ("up to $150.00" against a $200.00 mandate) satisfies every
check in this package. `test/binding.test.ts` asserts that, deliberately, and then asserts that the page still
refuses to call it verified — `readback_binding` is a `WARN` on every packet. A test that claimed the forgery
was caught would be asserting the thing the audit found missing.

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

### The offline checks

**Two kinds, and the distinction is the point.** A row whose evidence is a _recomputation_ (`integrity`) proves
internal consistency and nothing more, because anyone holding the document can recompute it. A row whose evidence
is a _comparison against a separately signed artefact_ (`binding`) is what actually establishes which transaction
a packet is about.

| id                        | category  | what it detects                                                           | evidence              |
| ------------------------- | --------- | ------------------------------------------------------------------------- | --------------------- |
| `bundle_hash`             | integrity | any edit to any member; the published digest vs a recomputation           | recomputation         |
| `custom_id`               | integrity | a core that no longer reproduces PayPal's `custom_id` (D18)               | recomputation         |
| `readback_hash`           | integrity | an edited consent read-back (EC-MER-6)                                    | recomputation         |
| `preferences_hash`        | integrity | an edited preferences block (EC-MER-6)                                    | recomputation         |
| `key_order`               | integrity | a canonical form that is _not_ order-independent                          | recomputation         |
| `required_members`        | schema    | EC-MER-6's anti-omission half                                             | presence              |
| `custom_id_binding`       | binding   | `paypal.custom_id` disagreeing with the recomputation (D-018)             | recomputation         |
| `checkout_binding`        | binding   | a price lock that is not the one L3b committed to (AT-M3.7)               | L3b vs the lock       |
| `gate_record`             | signature | **our own** Ed25519 signature on the decision record, against `jwks_keys` | the Gate key          |
| `gate_record_amount`      | binding   | a record approving a different amount from the price lock                 | the merchant key      |
| `gate_record_currency`    | binding   | a record approving a different currency                                   | the merchant key      |
| `gate_record_payee`       | binding   | a record approving a different payee                                      | merchant or agent key |
| `gate_record_chain`       | binding   | `chain_valid` false, which I-1 says authorised nothing                    | the Gate key          |
| `gate_record_vi_commit`   | binding   | a decision made by different library code                                 | the Gate key          |
| `gate_record_iat`         | binding   | a record decided outside the chain's own `iat` window, **both ways**      | four issuers          |
| `gate_record_attempt`     | binding   | **WARN always** — no signed artefact names an attempt                     | none                  |
| `gate_record_mandate`     | binding   | **WARN always** — no signed artefact names a mandate                      | none                  |
| `paypal_dispute_binding`  | binding   | a packet filed for a transaction it does not describe                     | the `disputes` row    |
| `readback_rendered`       | binding   | a read-back that is not §8.8's renderer's output                          | the compiler's rule   |
| `readback_cap_vs_mandate` | binding   | a read-back granting more than the signed mandate permits                 | the signed L2         |
| `readback_binding`        | signature | **WARN always** — no signature covers the read-back                       | none                  |
| `preferences_binding`     | signature | **WARN always** — no signature covers the preferences                     | none                  |
| `vi_lib_commit`           | schema    | a packet verified against another library version                         | presence              |
| `l1_disclosures`          | schema    | what the L1 actually discloses (EC-PRIV-3's boundary)                     | the L1                |

**Four rows are `WARN` on every packet, including an honest one.** That is not a defect and it is not something
a test may assert away: `gate_record_attempt`, `gate_record_mandate`, `readback_binding` and `preferences_binding`
report fields that **no signature in §7.3 reaches**. `test/verify.test.ts` asserts the exact set of four and that
each names its uncovered field, so a future change that quietly promoted one to `PASS` would fail rather than
ship. An untampered packet has **no FAIL and no SKIPPED** — both are still asserted — and four WARNs that are
true.

Plus, from `POST /v1/public/verify`: `chain_valid`, one row per `checks_performed`, one **WARN** per
`checks_skipped`, `constraints`, `network_enforced` (D19), `vi_bundle_hash`, `at_time` (EC-TIME-3), `vi_keys`.

### Two fields the signature row used to print without checking

`gate_record`'s old detail ended "The record says the Gate decided ALLOW for 13300 USD to mrc*northwind" — which
read as a verified claim and was neither checked nor even correct. `chain_valid` is now `gate_record_chain` and
is compared against §3.1 I-1's own precondition; `amount`/`currency`/`payee` are three more rows. The signature
row keeps its scope — \_the record has not been edited* — and says so, pointing at the rows that do the rest.

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

**The digests are necessary and nowhere near sufficient, and phase 2 says so.** Phase 1 catches every _edit_; it
catches no _substitution_, because recomputing two digests over a forged document is one line of work. Phase 2's
new rows — `gate_record_amount`, `_payee`, `_chain`, `_lib`, `_iat`, `readback_cap` — each compare against an
artefact the forger cannot re-sign, and they are what make the exit code mean something about _which_
transaction the document describes.

The script carries the same two unconditional `[WARN]`s the page does (`gate_record_ids`, `readback_binding`) and
a `WHAT IS NOT COVERED BY ANY SIGNATURE` section in its own header, so a reader learns the limits **before**
running it rather than after trusting a zero exit code. A `WARN` does not change the exit code, which is exactly
why the warning text has to carry the finding.

### Five decisions in the generated source worth knowing

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
5. **The money regex is written with doubled backslashes**, because the source lives inside a TypeScript template
   literal where a single `\d` is an escape sequence that vanishes before Python sees it. The failure is
   _silent_: the pattern still compiles and then matches nothing, so `readback_cap` reports `[SKIP]` on every
   read-back and looks like it has nothing to say. `test/verify-py.test.ts` therefore asserts `readback_cap`
   **PASSes** on the fixture — not merely that the script runs — which is the only assertion that would have
   caught it. A regex that cannot match is the worst kind of bug in a verifier.

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

### The substitution cases, which no digest can see

Every row above tampers with a field and lets a digest notice. `test/binding.test.ts` (page) and
`test/verify-py.test.ts` (script) each add the cases where the document is made **internally consistent** — both
digests recomputed, and for the record substitutions a **fresh, genuinely valid Ed25519 signature** produced by
`signDecisionRecord`, with the matching public key published so phase 3 verifies it like any other. Nothing about
the signature is wrong, which is exactly why the signature check `PASS`es and these rows have to exist.

| substitution                                          | caught by (page)                                     | caught by (script)                |
| ----------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| a record for another amount                           | `gate_record_amount`                                 | `gate_record_amount`              |
| a record for another payee                            | `gate_record_payee`                                  | `gate_record_payee`               |
| a record with `chain_valid` false                     | `gate_record_chain`                                  | `gate_record_chain`               |
| a record decided **before** the chain existed         | `gate_record_iat`                                    | `gate_record_iat`                 |
| a record decided **after** the chain was issued       | `gate_record_iat`                                    | `gate_record_iat`                 |
| a record for another attempt / mandate                | **not caught** — `WARN`, asserted                    | **not caught** — `WARN`           |
| `paypal` repointed at another capture, digests redone | `paypal_dispute_binding`                             | — (the script has no dispute row) |
| a read-back granting $9,999,999, digest recomputed    | `readback_cap_vs_mandate`                            | `readback_cap`                    |
| …the same, wearing `**What you are authorising**`     | `readback_cap_vs_mandate`                            | `readback_cap`                    |
| a read-back granting a _smaller_ invented allowance   | **not caught** — asserted, with the `WARN` beside it | same                              |

The last two rows are the honest boundary, and both are asserted in the suite. A forger who writes a smaller
invented allowance satisfies every digest and every ceiling check in existence, because **no signature in §7.3
covers the read-back**. The page does not claim otherwise; it says "treat the read-back as unauthenticated".

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

`paypal`, `shipments`, `buyer` and `preferences` are shaped as `packages/defender` shapes them, with made-up
values. Every check here is a check on the **document**, so none of that needs to be real, and §8.0 rule 5's
concern is about the **chain**, which is genuine throughout. The Gate key is a real Ed25519 key generated per
call, so `signDecisionRecord` → `verifyDecisionRecord` is a genuine round trip through `jose`.

### Two fixture corrections this work made, and what they hid

Both were found by the new checks rather than by review, which is the argument for having them.

**The Gate record's `amount` was in the wrong format.** The fixture signed `String(total_minor)` — `"13300"`.
`packages/gate/src/evaluate.ts` writes `toPayPalValue(amount)` — `"133.00"` — so **no Gate has ever produced the
format the fixture asserted**, and `gate_record_amount` read it as a $13,300 decision inside a $133.00 packet.
The check was right and the fixture was wrong. Nothing had noticed for the life of the fixture precisely because
no check compared the record's amount to the price lock.

**`FIXTURE_READBACK` was a paraphrase.** It is now in `readback.ts`'s output form — header first, `**bold**`
amounts — because `readStatedCaps` reads what the renderer writes and a fixture in another shape would prove
nothing. It is not rendered by the real `readBack()`: `fixtures/` cannot depend on `packages/compiler`, and
re-deriving the renderer here would be a second implementation of a template, the exact antipattern `bundle.ts`
exists to avoid. What is instead asserted is that the **sentinel** agrees — `test/binding.test.ts` imports
`READBACK_HEADER` from `packages/compiler` by relative path and compares, the same technique
`test/verify.test.ts` already uses for `publicPacketUrl`. One string is pinned; the rest is fixture data, and
every check that reads it reads it as data.

**The fixture's dispute row now carries `capture_id` and `order_id`.** Without them `paypal_dispute_binding`
would sit permanently `SKIPPED` — the one state in which it proves nothing — and every test in this package would
still pass.

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

6. **`readback` cannot be bound to any signature, and closing that needs `packages/orders`.** Reported in full
   under [What cannot be bound to anything](#what-cannot-be-bound-to-anything). In short: `custom_id` is derived at
   order-creation time from `EvidenceBundleCore`, which has no read-back member because `OrderDraft.mandate` has
   none — `mandates.readback` is not read by `packages/orders` at all. Adding `readback_sha256` to
   `EVIDENCE_BUNDLE_HASHED_MEMBERS` would make this verifier's recomputation disagree with the `custom_id`
   PayPal already holds on every filed packet, so the change has to begin at
   `packages/orders/src/create.ts::evidenceBundleCore` and add the digest to the `OrderDraft`.

7. **`att` and `mdt` are named by nothing signed.** Also in the same section. `apps/vi`'s
   `checkout_jwt.py::issue` already receives the attempt id (`checkout_id` is `chk_…`, and `l3.py` receives
   `attempt_id`), so putting `att` into the merchant-signed price-lock claims is a one-line payload addition —
   and it is the only one of the two that could be done without changing §7.3's shape.

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

// the signed anchors — decode only, never verification
readChainAnchors(bundle): ChainAnchors       // price lock, L3a, the iat window
readMonetaryCeiling(bundle): MonetaryCeiling // the signed L2's largest spending cap
readStatedCaps(readback, currency): bigint[] // the caps the text states
isCompilerReadback(value): boolean
READBACK_HEADER: string                     // §8.8's fixed first line

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
