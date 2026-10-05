# WP-15c / WP-15d — the drafter, the checker, the packet PDF and the QR

Spec **§8.15**'s `draftNotes` / `checkCitations` / `renderPacketPdf`, spec **§8.18**'s packet document.
Extends [`../README.md`](../README.md), which covers WP-15a (the router) and WP-15b (the planner).

```bash
pnpm --filter @countersign/defender typecheck
pnpm --filter @countersign/defender lint
pnpm --filter @countersign/defender test     # 456 tests, no network, no credentials, no key
pnpm --filter @countersign/defender eval     # 20 cases: citation coverage + false-claim rate
```

---

## The claim this half of the package has to make honestly

WP-15a answers §18 question 20 — _what stops us filing a bogus dispute?_ — with a rules table. **This half
answers question 27** — _"How do you stop the LLM inventing facts in evidence?"_ — and the answer is not a
prompt:

> **The model plans and drafts, and a deterministic checker decides whether the text is allowed to be
> filed.** (§8.15)

So:

| Question                       | Answered by                                                    | Can a model influence it? |
| ------------------------------ | -------------------------------------------------------------- | ------------------------- |
| May we contest at all?         | `route()` — 22 rules, first match wins                         | **no**                    |
| Which facts exist to assert?   | `claimSourcesFor()` — pure composition over rows               | **no**                    |
| Write the prose                | `draft()` in `drafter.ts`, through an injected `LanguageModel` | yes, entirely             |
| **May this text be filed**     | **`checkCitations()` in `citation-check.ts`**                  | **no**                    |
| What goes in the PDF, redacted | `renderPacketPdf()` in `evidence-doc.ts`                       | no                        |

### A worked example: one claim, end to end

The disputed amount on an `UNAUTHORISED` case with a 12999 minor-unit USD capture:

```
ClaimSource  { id:      'clm_dispute_amount',
               phrase:  'USD 129.99',                                  ← exactly what must be written
               artefact:{ id: 'capture:3AB12345', kind: 'capture',
                           description: 'the PayPal capture 3AB12345' },
               support: 'record',
               money:   { minor: 12999n, currency: 'USD' } }

Model writes "The buyer is disputing USD 129.99 [[clm_dispute_amount]]."

Checker      1. splitSentences → one sentence
             2. marker parses → 'clm_dispute_amount' → resolves in ClaimSource
             3. containsPhrase(body, 'USD 129.99')  → yes
             4. currenciesIn(body) = ['USD']       → equals source.money.currency
             5. no delivery word, no notification verb, no URL
             → ok

Filed        notes      = the text above, marker included (§8.15 puts the tags in the notes)
             citations  = [{ claimId: 'clm_dispute_amount',
                            sentence: 'The buyer is disputing USD 129.99.',
                            artefact: { id: 'capture:3AB12345', … }, support: 'record' }]
             → evidence_packets.citations

Packet PDF   section 4 prints:  "The buyer is disputing USD 129.99."
                           and:  "cited as clm_dispute_amount · artefact capture:3AB12345 ·
                                    the PayPal capture 3AB12345 · record"
```

Now change one digit — `USD 129.98` — and step 3 fails: `PHRASE_NOT_IN_SENTENCE`, and **no citation is
recorded**, because a blocked sentence must not appear in `citations`. That is the whole deliverable.

---

## Every way the checker can BLOCK

Ten codes, closed. `CITATION_PROBLEM_CODES` exports the list and `test/citation.test.ts` asserts it.

| Code                     | Fires when                                                                      | Real-world instance                              |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `EMPTY_NOTES`            | the note is empty or whitespace                                                 | PayPal requires ≥ 1 character                    |
| `TOO_LONG`               | > 2000 characters (`SPEC-D` `maxLength: 2000`)                                  | EC-DSP-12                                        |
| `MALFORMED_MARKER`       | `[[clm_x` unclosed, `[[Clm_X]]`, `[[clm_dispute.amount]]`                       | a typo silently removing a citation              |
| `UNKNOWN_CLAIM_ID`       | the marker names a claim this packet does not have                              | a model inventing evidence                       |
| `UNCITED_SENTENCE`       | a sentence with **no** marker that is not boilerplate                           | "we have always treated our buyers fairly"       |
| `PHRASE_NOT_IN_SENTENCE` | the marker resolves, its phrase is absent                                       | a forged amount, a forged status                 |
| `CURRENCY_MISMATCH`      | a cited money claim and the sentence names another ISO code                     | the right figure in the wrong currency (EC-FX-1) |
| `FORBIDDEN_DERIVATION`   | a delivery, carrier-verification or notification claim with no record behind it | EC-MER-4, and "the buyer was notified"           |
| `DISALLOWED_URL`         | any URL but `PUBLIC_BASE_URL` + `/v/{packetId}`, or a bare domain               | a tracking-parameterised redirect                |
| `DUPLICATE_URL`          | the one permitted address, twice                                                | —                                                |

Every problem carries **the offending sentence verbatim**, because `Draft.blocked` is rendered in S-18 and a
human decides on it. The shape is fixed: `[CODE] "<the sentence>" — <why>`.

### The three guards that keep a rule from firing on an identifier

All three rule families (currency, delivery, notification) guard against matching **inside an identifier**,
and all three guard because they were caught doing it:

| Found                                                | Symptom                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `\bINR\b` matched inside `R-INR-2`                   | every correct not-received note was refused on its rule id alone                                        |
| `\bnotified\b` matched inside `INV-bad-05-notified`  | a correct note was refused as a notification claim — found by the 20-case drafter eval on its first run |
| `\bdelivered\b` would match inside `SKU-DELIVERED-9` | a correct note quoting the disputed line would be refused                                               |

`(?<![A-Za-z0-9_-])…(?![A-Za-z0-9_-])` instead of `\b`. **Fail-closed reasoning does not extend to "refuse a
correct filing"** — an unusable checker gets bypassed, and a bypassed checker is worse than no checker.

---

## How the 2000-character truncation is made explicit rather than silent

`truncateNotes()` drops **whole sentences** and appends a **constant** notice.

**Why sentences, not `slice()`:** a note that ends mid-claim is still read as a claim. If the cut lands inside
`"the buyer was notified on…"`, the fragment that survives still asserts notification, its marker is gone, and
the checker — correctly — blocks it. That is a rejected filing, a spent response, and a human woken up to
debug our truncation rather than their dispute.

**Why a constant notice and not `"[412 of 4891 chars]"`:** a digit in an uncited sentence is an uncitable
digit, so an informative truncation notice would itself fail the checker. The numbers live on
`TruncationReport` instead — returned on the `Draft`, logged by `draft()`, and rendered by the packet PDF —
and the note itself gets one fixed, allowlisted sentence saying that sentences were omitted and where they are:

> Some sentences were omitted to fit PayPal's limit on this field; the omitted text is in the attached packet PDF.

**The checker runs again on the truncated text.** Truncation happens between two checks, not instead of one,
so the `citations` list is a list of what is _in the packet_ rather than what the model wrote. A pre-truncation
pass uses `ignoreLength` so that **no claim problem can be truncated away before it is judged** — truncate-then-
check-once would let a model hide a forgery at position 1900 behind the sentences the clamp drops.

---

## WP-15d — the packet PDF and the QR

### The nine sections, in §8.18's order

`packetSectionOrder()` is exported and asserted against the _extracted_ text, so the order cannot be quietly
changed. Each is a question a reader asks in sequence.

| §   | Heading                                      | The reader asks                        | Data                                                 |
| --- | -------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| 1   | What this document is                        | "What am I holding?"                   | packet id, dispute id, version                       |
| 2   | The decision                                 | "Who decided, and how?"                | rule id, posture, liability, rationale, reasons      |
| 3   | The facts the rule compared                  | "On what?"                             | the `RouterFact`s                                    |
| 4   | The claims, and the artefact behind each one | "What is asserted, and what backs it?" | `draft.citations`                                    |
| 5   | The signed chain                             | "Signed by what?"                      | L1/L2/L3a/L3b, checkout, Gate decision, fingerprints |
| 6   | The read-back the buyer approved             | "What did they approve?"               | `chain.readback`, verbatim (EC-MER-6)                |
| 7   | Capture screenshot                           | "Where is the photo?"                  | an empty labelled frame                              |
| 8   | Verify it yourself                           | "Do I have to trust you?"              | the QR and the public address                        |
| 9   | What this packet does not claim              | "What are you hiding?"                 | EC-MER-4 and EC-MER-6 in the packet itself           |

### Determinism, and why it is a spec requirement

**The same packet renders byte-identical output** (§8.18 "reproducible"), because two renders of one packet
must be comparable or `evidence_packets.pdf_sha256` changes for no reason and a re-render looks like a tamper.

Three specific `pdf-lib` behaviours had to be handled, and the tests assert **both directions**: the same clock
gives the same bytes, _and a different clock gives different bytes_ — otherwise the first assertion would pass
for the wrong reason.

1. **No wall clock.** `setCreationDate`/`setModificationDate` take the **injected `Clock`**. `pdf-lib`
   otherwise stamps `new Date()`.
2. **No variable metadata.** Producer, Creator, Title, Subject, Author and Keywords are all set explicitly.
3. **`useObjectStreams: false`.** Object streams are zlib-compressed, and a compressed stream's bytes depend
   on the zlib build rather than on our input.

### Redaction is a test, not a hope

EC-PRIV-2/3. `test/evidence-doc.test.ts` **decodes the text back out of the rendered bytes and greps that**,
because asserting on the inputs proves only that the inputs were clean. The decoder reads glyph ids from the
content stream and maps them through the document's own `/ToUnicode` CMap — the same mapping a PDF reader
uses, so it is not a mirror of our own draw calls.

The fixture plants every secret in every field it can reach: an email and a card number inside the read-back
_prose_, a payer id, an access token inside a bundle value, and an `errors[]` entry whose `details` carries
`access_token`, `signing_key`, `payer_email` and a `debug_id`. The greps:

| Grep                                                                      | Result                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `SECRET_EMAIL`, `asha.rane`, `example.com`                                | absent — `a***@e***.com` is printed instead                                     |
| `SECRET_CARD`, any `\b\d{12,}\b`                                          | absent — `****-****-****-1111` is printed instead                               |
| `SECRET_PAYER_ID`                                                         | absent — `PAYE**************UV`                                                 |
| `SECRET_ACCESS_TOKEN`, `SECRET_SIGNING_KEY`                               | absent                                                                          |
| `access_token:`, `signing_key:`, `client_id:`, `payer_email:` … as labels | absent                                                                          |
| `EVIDENCE_TOO_LARGE` (a `details` value)                                  | absent — `details` is **never rendered**, not redacted                          |
| `l1.abc.def`, `l2.abc.def` (artefact tokens)                              | absent — a 16-hex fingerprint and the first 8 chars instead                     |
| `PP_UNPROCESSABLE`                                                        | **present** — the code and `retryable`, because the case file needs to know why |

**One leak was found this way and fixed:** a payer id pasted into read-back _prose_, where there is no key to
key off, survived both the email rule and the card rule. `redactForPacket` now masks `\bPAYER[A-Z0-9]{6,}\b`.

### The font: Roboto Regular, Apache-2.0

`packages/defender/assets/fonts/Roboto-Regular.ttf`, retrieved 2026-10-05 from `googlefonts/roboto-2`,
**SHA-256 `56a45233…d6664d`** (pinned by a test), with `Roboto-LICENSE.txt` and `FONT-LICENCE.md` beside it.
The repository's own licence is Apache-2.0, so redistribution inside this tree is compatible and the NOTICE
obligation is met.

Committed rather than fetched, for two reasons, both about §8.18's reproducibility: a font fetched at build
time makes the bytes depend on the network **and** on which version arrived (the glyph subset changes), and a
_system_ font makes them depend on the machine — Render's image does not have the same font set as a laptop, so
the same packet would render with different metrics and different bytes. The font is a pinned input here, like
the VI library commit.

`@pdf-lib/fontkit` is needed because `pdf-lib`'s base-14 fonts are **WinAnsi**: `₹`, `€`, `£` and the
typographic characters in the compiler's read-back are not encodable, and a read-back that silently loses its
ellipsis is a read-back nobody signed. `assertEncodable` additionally **pre-scans** every string and refuses to
render rather than dropping a character.

### The QR

`PUBLIC_BASE_URL` + `/v/{packetId}`, **and nothing else**. Three assertions, because one is not enough:
the payload equals the address; the drawn matrix is bit-identical to the library's encoding of that address
(nothing else drawn into it); and changing one character changes the matrix (so the first two are
discriminating rather than vacuous). **Honest limit:** this is a round-trip identity check against `qrcode`,
not an independent decoder — it establishes that we encode exactly the string we mean to.

---

## The drafter

### The prompt is not the control

`buildDrafterSystem()` carries the signer-approved read-back, the chain identifiers, the order and capture
facts, and **the exact list of claims that are allowed** with each one's phrase and artefact. It states the
output contract explicitly because a model that does not know it produces text the checker must refuse, and
refusing costs a human.

It also says out loud: _"You are NOT deciding whether to contest. A deterministic rules table already decided
that, and it cannot be changed by anything you write."_

If the prompt were the control, every one of the six negative tests would be a test of the model's mood on the
day — and the day a model is confidently wrong is exactly the day a merchant's good customer gets a dispute
filed against them.

### The pipeline

```text
model text ─▶ check ─▶ ok? ─yes─▶ truncate ─▶ check ─▶ ok? ─yes─▶ FILE
                │no                                  │no
                ▼                                    ▼
          retry once, problems                deterministic template ─▶ check ─▶ FILE
          listed (§8.15)                                  │no
                                                     DEF_CITATION_FAILED
```

Four properties, each pinned by a test:

1. **`LLM_UNAVAILABLE` produces no `Draft` value at all** — not one with `blocked`, not one with empty notes.
   An empty answer is `LLM_SCHEMA`, not an empty filing.
2. **The checker runs on the final text, after truncation** (EC-MER-5).
3. **A posture that files nothing never reaches the model.** `R-SNAD-AGENT` decided `REFUND`; asking a model
   to write an argument for it is asking it to argue against our own finding. `draft()` returns
   `DEF_WRONG_STATE` **before it calls anything** — asserted by `llm.requests` being empty.
4. **At most two model calls**, §8.15's one repair turn, made into a bound.

### `notes` keeps its markers, and that is §8.15's design

§8.15 requires "every sentence in the notes … to carry `[F:key]` tags", so the tags live in the **filed** text.
That is what makes EC-MER-5 enforceable: a merchant who edits `notes` by hand removes the markers, every edited
sentence becomes uncited, and the filing is blocked with _"these sentences lack a source"_. If the filed text
had no markers and the citations were tracked separately, a hand edit would silently keep the old citations —
which is exactly EC-MER-5's attack. `plainNotes()` is the presentation form, and the PDF prints that.

---

## The 20-case drafter eval

`eval/drafter-cases.jsonl`, scored by **`test/drafter-eval.test.ts`**. Eight rows a well-behaved model would
write, **twelve designed to trip one specific rule each** — an eval with no defects in it measures nothing.

```
pnpm --filter @countersign/defender eval
```

> **Why not `test/eval.test.ts`:** that name is taken — it is WP-15a's 40-case router eval, the §8.16 AT-M15.1
> measurement, and the `eval` script runs both. Renaming either file is a decision for whoever owns
> `packages/defender/package.json`, not something to do silently inside another work package.

### What it reports, and what it gates

| Metric                | Definition                                    | Denominator                   |
| --------------------- | --------------------------------------------- | ----------------------------- |
| **citation coverage** | marker-bearing sentences the checker accepted | every marker-bearing sentence |
| **false-claim rate**  | sentences refused for a _claim_ reason        | **every** sentence            |

The false-claim rate's denominator is _all_ sentences, because a sentence with no marker is the most dangerous
kind: it reads perfectly and asserts something nobody signed. One bad sentence counts once, not once per
problem — `EUR 129.99` produces both `PHRASE_NOT_IN_SENTENCE` and `CURRENCY_MISMATCH`, and counting problems
would inflate the rate for exactly the cases that matter most.

`TOO_LONG`, `DISALLOWED_URL` and `DUPLICATE_URL` are refusals but not _false claims_: nothing untrue was
asserted. They are reported as `otherProblems`.

**Neither rate is gated on a threshold**, and that is deliberate: the rate is a property of the model, and a
threshold here would be a number fitted to a fixture. What _is_ gated is the invariant underneath:

> **After the pipeline runs, the note that gets filed has a false-claim rate of zero on every case.**

That asymmetry is the product claim. A model that cited nothing would score 0% coverage and would still produce
filings indistinguishable, to a reader, from a perfect model's.

### Provenance, and why no key is needed

`docs/HUMAN_TODO.md` **H-02** is open, so every row carries an explicit `provenance` and the report prints
which it scored:

> `… 20 cases, 20 scripted (no live capture: H-02 open)`

- `"scripted"` — written by hand against the prompt contract. Honest about being a fixture: it measures the
  **pipeline**, and it is what makes `pnpm eval` green with no network.
- `"live"` — drop a `drafter-cases.live.jsonl` beside it (`{id, modelText}` per line) and it is merged in by
  id, winning over the scripted row. Nothing in `drafter-cases.ts` ever writes to the JSONL.

**A number that does not say where it came from is not a measurement.**

### Two things the eval found, and a case it could not cover

- The `INV-bad-05-notified` false positive (above).
- A "no passkey" case was **removed rather than fixed**: `R-UNAUTH-3` decides `REVIEW`, so the router refuses
  to file it and the drafter is never reached. A drafter-eval case about it would have scored nothing and
  quietly looked like a coverage win. That is the router running first, and it belongs in the router eval.

---

## Two rules that are stronger than §8.15 asks for, and why

1. **One currency per sentence.** §8.15 requires the value to appear verbatim. A sentence naming two
   currencies is refused whichever way the amounts are arranged, because at that point neither the reader nor
   the checker can say which figure is in which currency.
2. **`UNUSED` and `EMPTY` claim phrases are dropped** rather than emitted. An empty phrase is a substring of
   every sentence, so `PHRASE_NOT_IN_SENTENCE` could never fire for it — an uncitable fact stays uncitable.

Both are documented extensions in the same spirit as the router's rule-id extensions: a spec rule still
exists and still fires, and the extension is the narrower reading of it.

---

## Contract gaps and things this half could not do

- **`draft()` never imports `ai`.** The `LanguageModel` port is one function, so a caller supplies
  `(system, prompt) => generateText({model, system, prompt}).then(r => r.text)` and this package still never
  learns which SDK is behind it. `packages/defender/package.json` carries `ai` and `@ai-sdk/openai` from
  WP-15a and **neither is imported anywhere in `src/`** — `test/citation.test.ts` and `test/rules.test.ts`
  both assert it. That is deliberate (the package has no model in its graph at all) and it means those two
  dependencies are currently unused.
- **`gate:<id>` as an artefact kind** is an extension on the brief's list. The signed Gate decision is part of
  the §7.3 bundle and §8.15's `R-UNAUTH-1` argument _is_ "the Gate allowed this", so a claim about it needs an
  artefact; without one the strongest fact in an `UNAUTHORISED` packet would be uncitable.
- **The screenshot slot is empty by design.** §8.18 mandates the slot; the renderer draws a labelled frame and
  says it is not populated by this renderer. Attaching merchant screenshots needs a storage surface this
  package does not have.
- **No capture script for `drafter-cases.live.jsonl` is committed**, because it needs a key to run and cannot
  be tested without one. The merge format is documented above.
- **`docs/edge-cases.json` still lists `EC-DSP-10`, `EC-DSP-11` and `EC-PRIV-2` as `todo`** even though they
  now have referencing tests. `pnpm test:ec` reports them under _"have a test but are still status `todo`"_,
  which is the correct signal — `docs/` is not this work package's to edit, so flipping the status is a
  follow-up.
- **The screenshot slot is empty and unpopulated**; see above.
