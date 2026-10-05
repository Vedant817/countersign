/**
 * `checkCitations()` — spec **§8.15**'s "Citation checker (deterministic)", work package **WP-15c**.
 *
 * ```ts
 * const verdict = checkCitations(draft, claims, { allowedUrl })
 * if (!verdict.ok) return err(csError('DEF_CITATION_FAILED', …))
 * ```
 *
 * ## The one rule this file exists to enforce
 *
 * **A claim without a citation is never filed.** Spec **§18 question 27** asks "How do you stop the LLM
 * inventing facts in evidence?" and §8.15 answers it in four lines: every sentence containing a number,
 * date, id or claim carries a `[F:key]` tag; the tag must exist; its value must appear verbatim in the
 * sentence; notes are ≤ 2000 characters with no URL but `PUBLIC_BASE_URL/v/…`.
 *
 * This file implements that answer, and it is worth being explicit about **which part is the control**.
 *
 * | Step | Who does it | Can a model influence it? |
 * |---|---|---|
 * | Decide whether to contest | `route()` — a rules table | no |
 * | Decide which facts exist | `claimSourcesFor()` — pure composition over rows | no |
 * | Write the prose | the drafter, in `drafter.ts` | **yes, entirely** |
 * | **Decide whether the prose may be filed** | **this file** | **no** |
 *
 * The model is allowed to write anything. It is not allowed to *keep* anything. That is the whole
 * design, and it is why the drafter and the checker are two files with opposite dependencies: the
 * drafter imports `ai`, this file imports nothing.
 *
 * **The ESLint `no-restricted-imports` ban for this file is in `eslint.config.mjs` under
 * `ROUTER_LLM_BAN`,** next to `rules.ts` / `router.ts` / `rationale.ts`. The check is deliberately
 * *stricter* than theirs: they must not import a model because they must not **choose** a posture, and
 * this file must not import a model because it must not **approve** a claim. A checker that asked a
 * model "does this look well-supported?" would be a rubber stamp with extra steps, so the ban exists
 * and `test/citation.test.ts` asserts the boundary structurally as well (an ESLint rule cannot run
 * inside vitest, and a rule nobody has watched fire is a rule nobody has checked).
 *
 * ## Fail closed, always
 *
 * There is exactly one safe default here and it is `BLOCKED`:
 *
 * - a sentence with **no** marker is boilerplate (a fixed allowlist) or it is blocked;
 * - a marker naming an **unknown** claim id is blocked;
 * - a marker whose source **does not support** the sentence — the phrase is absent, the currency
 *   disagrees, or the sentence derives a delivery fact from a merchant-typed tracking number — is
 *   blocked (spec **EC-MER-4**: "an assertion is not evidence");
 * - a **disallowed URL**, a **bare domain**, or the allowed URL more than once is blocked.
 *
 * Every problem carries the offending sentence **verbatim**, because `Draft.blocked` is rendered in S-18
 * and a human decides on it. "2 sentences lack a source" is what spec EC-MER-5's expected-UI column
 * says; a message that said "citation error" would be a message nobody can act on.
 *
 * ## Why ids and not fuzzy text matching
 *
 * The first version of any citation checker is "does the sentence contain the fact's value?", and it is
 * wrong in a way that only shows up in production: `"true"` is a substring of `"untrue"`, `$129.99` is
 * a substring of `$1,299.90`, and a value that appears in a sentence for an unrelated reason passes.
 * So the model emits `[[clm_capture_amount]]`, the checker resolves the **id**, and the phrase check
 * becomes a *consistency* check between the resolved source and the sentence rather than a text search.
 */

import { formatIstHuman, formatMoneyCode, type Money } from '@countersign/core'

import { completedRefunds, disputedSkus, trackedShipments } from './rules'
import type { ChainFacts, DisputeContext, LiabilityDecision } from './types'
import { NOTES_MAX_CHARS } from './types'

/**
 * The evidence kinds a claim can be backed by, and the artefact ids spec §8.15's packet format uses.
 *
 * `gate` is an extension on the same terms as the router's documented extensions: the signed
 * `gate_decisions` record is part of the §7.3 bundle and §8.15 R-UNAUTH-1's argument is "the Gate
 * allowed this", so a claim about it needs an artefact id. Without one, "the merchant's Gate approved
 * this purchase" would be an uncitable assertion — which is correct, but it would also make the single
 * strongest fact in an `UNAUTHORISED` packet unusable.
 */
export type ClaimArtefactKind =
  | 'l1'
  | 'l2'
  | 'l3'
  | 'gate'
  | 'tracking'
  | 'capture'
  | 'refund'
  | 'checkout'

export interface ClaimArtefact {
  /** The exact string §7.3's bundle uses: `l1`, `l2`, `l3`, `gate:<id>`, `tracking:<trackerId>`, `capture:<id>`, `refund:<id>`, `checkout:<id>`. */
  readonly id: string
  readonly kind: ClaimArtefactKind
  /** One line a human reads next to the claim. Quoted in `blocked` reasons. */
  readonly description: string
}

/**
 * Whether the artefact is a **record** somebody else holds, or an **assertion** the merchant typed.
 *
 * This is spec **EC-MER-4** made into a type. "Not detectable by us" is the honest answer to "did the
 * parcel really ship?", so a tracking number the merchant typed into their own dashboard can back a
 * claim that we *dispatched* it and cannot back a claim that the *carrier delivered* it — the checker
 * refuses the second outright, with {@link CitationProblemCode} `FORBIDDEN_DERIVATION`.
 */
export type ClaimSupport = 'record' | 'assertion'

/**
 * One fact a drafted note is permitted to assert.
 *
 * **`phrase` is the only thing the checker matches against the sentence**, and it is chosen so that only
 * the *true* form passes. A boolean fact is therefore given a phrase that flips with the fact:
 * `clm_chain_verified` is `'chain verified'` when the chain verifies and `'chain did not verify'` when
 * it does not, so a sentence saying "the chain is broken" on a good chain is blocked without the
 * checker needing to understand English.
 */
export interface ClaimSource {
  /** Stable, dot-free (`clm_…`) so it cannot be confused with a host name by the bare-domain check. */
  readonly id: string
  /** The exact substring the citing sentence must contain. Empty strings are rejected. */
  readonly phrase: string
  readonly artefact: ClaimArtefact
  readonly support: ClaimSupport
  /** Present when {@link ClaimSource.phrase} is a money value; the currency the checker compares against. */
  readonly money?: Money
  /** One sentence for the prompt: what may be asserted from this claim. Never rendered into a note. */
  readonly instruction: string
}

/** A `[[clm_x]]` marker resolved to the source that backs it. */
export interface Citation {
  readonly claimId: string
  /** The sentence, markers removed, exactly as it would be filed. */
  readonly sentence: string
  readonly artefact: ClaimArtefact
  readonly support: ClaimSupport
}

/**
 * Every way the checker can refuse. The set is closed on purpose: `test/citation.test.ts` asserts it is
 * exhaustive, so a new refusal cannot be added without a test naming it.
 */
export type CitationProblemCode =
  /** The notes are empty or whitespace. PayPal requires at least one character. */
  | 'EMPTY_NOTES'
  /** Over PayPal's documented `notes` cap (`SPEC-D`: `maxLength: 2000`). */
  | 'TOO_LONG'
  /** A `[[…]]` that is not a well-formed lowercase claim id, or an unclosed `[[`. */
  | 'MALFORMED_MARKER'
  /** A marker naming a claim id that does not exist. */
  | 'UNKNOWN_CLAIM_ID'
  /** A sentence with no marker that is not in the fixed boilerplate allowlist. */
  | 'UNCITED_SENTENCE'
  /** The marker resolves, but its phrase does not appear verbatim in the sentence. */
  | 'PHRASE_NOT_IN_SENTENCE'
  /** A cited money claim, and the sentence names a different ISO-4217 code. */
  | 'CURRENCY_MISMATCH'
  /** EC-MER-4: a delivery, notification or carrier-verification claim with no record behind it. */
  | 'FORBIDDEN_DERIVATION'
  /** A URL other than the one permitted `PUBLIC_BASE_URL` + `/v/{packetId}`. */
  | 'DISALLOWED_URL'
  /** The one permitted URL, more than once. */
  | 'DUPLICATE_URL'

export interface CitationProblem {
  readonly code: CitationProblemCode
  /** The offending sentence, verbatim. A human decides on this in S-18. */
  readonly sentence: string
  /** Why, in one line, naming the claim or the string. */
  readonly detail: string
}

export interface CitationVerdict {
  /** `true` only when `problems` is empty. There is no third state: never "probably fine". */
  readonly ok: boolean
  readonly problems: readonly CitationProblem[]
  readonly citations: readonly Citation[]
  /** Claim ids cited at least once, in first-mention order. */
  readonly citedClaimIds: readonly string[]
  /** Claim ids available and never cited. Reported, never a reason to block. */
  readonly unusedClaimIds: readonly string[]
}

/** `checkCitations`' only configuration. */
export interface CitationOptions {
  /**
   * The one URL a note may contain: `PUBLIC_BASE_URL` + `/v/{packetId}`.
   *
   * When absent, **no URL at all is permitted** — the default is the restrictive one, because a
   * caller that forgets to pass a base URL should get a stricter check rather than a looser one.
   */
  readonly allowedUrl?: string
  /** Hard cap on the notes. Defaults to `NOTES_MAX_CHARS`. A caller may lower it, never raise it. */
  readonly maxChars?: number
  /**
   * Skip the `TOO_LONG` check. **The only caller is `draft()`**, which uses it for the pre-truncation
   * pass so a long-but-honest note is not refused for its length, truncates immediately afterwards, and
   * then re-checks the truncated text with the limit in force.
   *
   * It exists so that **no claim problem can be truncated away before it is judged.** Truncating first and
   * checking once would let a model hide a forgery at position 1900 behind sentences the clamp drops.
   */
  readonly ignoreLength?: boolean
}

// ---------------------------------------------------------------------------
// The marker and the sentence splitter
// ---------------------------------------------------------------------------

/**
 * A well-formed claim marker. Deliberately strict: lowercase, digits and underscores only.
 *
 * The looseness is what the "one URL" rule and the bare-domain rule both rely on — a claim id that
 * could contain `.` or `/` could smuggle a link past the URL check by writing `[[click.here]]`.
 */
const MARKER = /\[\[([a-z0-9_]+)\]\]/g

/** Anything that *looks* like it was meant to be a marker. Used to catch the malformed ones. */
const MARKER_SHAPE = /\[\[|\]\]/

/**
 * Split into sentences on `.`/`!`/`?` followed by whitespace, or on a newline.
 *
 * **A period inside a number does not split** (`$1,299.00.` splits after the final stop, not after
 * `00`), because the separator requires trailing whitespace. That is the whole reason the pattern looks
 * the way it does: the naive `/[.!?]/` splits every amount into two "sentences", each of which is then
 * judged on its own and fails for having no marker.
 *
 * **A single newline is a soft wrap, not a sentence boundary.** `notes` is a plain text field and PayPal
 * wraps it; splitting on `\n` alone turned `"The buyer is disputing\nUSD 129.99 [[clm_dispute_amount]]."` into
 * two half-sentences, each of which then failed for having no marker. A **blank** line still separates,
 * because that is the only place a model actually means a new paragraph.
 *
 * **An orphan marker run is pulled back onto the sentence before the full stop.** Models write
 * `"the capture was USD 129.99. [[clm_capture_amount]]"` at least as often as they write the marker
 * before the stop, and both mean the same thing. Without the merge the marker becomes its own
 * "sentence", the real sentence loses its citation, and a correct draft is refused for a formatting
 * difference — which is how people learn to ignore a checker. A marker run is a marker, a stop is a stop,
 * and this function is only about which sentence a marker belongs to.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const part of text.split(/(?<=[.!?])\s+|\n[ \t]*\n+/)) {
    const trimmed = part.replace(/\s*\n\s*/g, ' ').trim()
    if (trimmed.length === 0) continue
    const previous = out[out.length - 1]
    if (previous !== undefined && ORPHAN_MARKER_RUN.test(trimmed)) {
      out[out.length - 1] = `${previous} ${trimmed}`
      continue
    }
    out.push(trimmed)
  }
  return out
}

/** A chunk that is nothing but markers and the punctuation around them. */
const ORPHAN_MARKER_RUN = /^[\s.,;:!?]*(?:\[\[[a-z0-9_]+\]\])+[\s.,;:!?]*$/

// ---------------------------------------------------------------------------
// The boilerplate allowlist
// ---------------------------------------------------------------------------

/**
 * Sentences a note may contain **without** a citation.
 *
 * Every entry is a claim about *us* or about *this document* — never about the payment, the parcel or
 * the buyer. That is the whole test for membership: if a sentence could be false about this dispute, it
 * does not belong here, because an uncited sentence is exactly what the checker exists to refuse.
 *
 * The allowlist is fixed and small on purpose. Widening it is how "block anything unrecognised" quietly
 * stops being the default, and `boilerplateViolations()` exists so that widening it has to fail a test.
 */
export const BOILERPLATE_SENTENCES: readonly string[] = [
  "This note was written from the merchant's own records by Countersign, the payment-intent layer.",
  'The signed purchase record is in the attached packet.',
  'Anyone can re-verify the attached packet at the public address below without trusting us.',
  "The payment was made through the merchant's own checkout, and PayPal's own records agree with it.",
  'This packet makes no claim about the carrier, and treats a merchant-entered tracking number as an assertion only.',
  'Nothing in this packet is generated: every figure below is quoted from a stored record.',
  // The truncation notice `truncateNotes` appends. Fixed string, no digits — a number in it would be an
  // uncitable number, which is exactly the bug `truncateNotes`'s own doc comment is about.
  "Some sentences were omitted to fit PayPal's limit on this field; the omitted text is in the attached packet PDF.",
]

/**
 * The one boilerplate sentence that cannot be a constant: it carries the permitted URL.
 *
 * Deriving it rather than pattern-matching it means the checker and the drafter cannot disagree about
 * the wording — a near-miss like `"at the address below: https://…"` is refused, which is correct, because
 * the alternative is a rule that accepts anything containing the URL.
 */
export function publicAddressSentence(allowedUrl: string): string {
  return `Anyone can re-verify the attached packet at the public address below without trusting us: ${allowedUrl}`
}

/**
 * Is this sentence one of the permitted marker-free sentences?
 *
 * A trailing full stop is tolerated on the two link-shaped cases, because `The address is https://…` ends
 * with a stop and the link scanner already excludes sentence punctuation — the checker must agree with it,
 * or the permitted link is refusable by putting it last in a sentence.
 */
function isBoilerplate(body: string, allowedUrl: string | undefined): boolean {
  if (BOILERPLATE_SENTENCES.includes(body)) return true
  if (allowedUrl === undefined) return false
  const bare = body.replace(/\.$/, '')
  // A bare link asserts nothing, so it is not a claim. Permitted once, and `DUPLICATE_URL` enforces that.
  if (bare === allowedUrl) return true
  // The one boilerplate sentence that carries the URL. Derived from the same function the drafter writes
  // it with, so the two cannot drift into disagreeing about the exact wording.
  return bare === publicAddressSentence(allowedUrl)
}

/**
 * Boilerplate that is not actually claim-free.
 *
 * Exported so `test/citation.test.ts` can assert it is empty instead of trusting a reviewer's eye. The
 * rules are: no digit, no money symbol, no URL, no ISO-4217 code, and no sentence that could be false
 * about *this dispute*.
 */
export function boilerplateViolations(): readonly string[] {
  const bad: string[] = []
  for (const s of BOILERPLATE_SENTENCES) {
    if (/\d/.test(s))
      bad.push(`${s} — contains a digit, and a digit in an uncited sentence is a claim`)
    if (/[$€£₹¥]/.test(s)) bad.push(`${s} — contains a money symbol`)
    if (CURRENCY_PRESENT.test(s)) bad.push(`${s} — names a currency`)
    if (URL_PRESENT.test(s)) bad.push(`${s} — contains a URL`)
    if (s.includes('[[')) bad.push(`${s} — contains a marker`)
  }
  return bad
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

/**
 * `$` is read as USD. The demo store is USD (spec §2) and `formatMoneyCode` — the form the packet and
 * every fact use — always names the ISO code, so a `$` beside an explicit `EUR` is the only way a `$`
 * reaches the checker at all. Reading it as USD makes that sentence a mismatch, which is the safe
 * direction: a blocked note becomes a human decision, and a filed note with the wrong currency does not.
 */
const CURRENCY_TOKENS: Readonly<Record<string, string>> = {
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
  INR: 'INR',
  JPY: 'JPY',
  AUD: 'AUD',
  CAD: 'CAD',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
}

/**
 * `A$` and `C$` are matched **before** the bare `$`, because `$` is a suffix of both.
 *
 * **The lookarounds are load-bearing, and they exist because of a bug this file hit and then caught:**
 * `\bINR\b` matches the `INR` inside the rule id **`R-INR-2`**, because `-` is a non-word character, so
 * both edges of `INR` *are* word boundaries. That made the currency rule fire on the rule id of every
 * not-received dispute — refusing correct notes on the one rule whose whole job is to win a delivery
 * case — while every number in the same sentence was consistent. Requiring that a currency code is **not**
 * flanked by `-`, `_` or another word character keeps rule ids, SKUs, tracking numbers and claim ids out
 * of the currency vocabulary.
 *
 * Two regexes rather than one, and the split is deliberate: {@link CURRENCY_SCAN} is global because it is
 * consumed by `matchAll`, and {@link CURRENCY_PRESENT} is not global because it is consumed by `.test()`.
 * A `g`-flagged regex carries `lastIndex` between calls, so using one for both makes
 * `boilerplateViolations()` return a different answer on every other sentence — a bug that would have
 * passed a test written with a single boilerplate string in it.
 */
const CURRENCY_TOKEN_SOURCE =
  '(?<![A-Za-z0-9_-])(?:A\\$|C\\$|[$€£₹¥])|(?<![A-Za-z0-9_-])(?:USD|EUR|GBP|INR|JPY|AUD|CAD)(?![A-Za-z0-9_-])'
const CURRENCY_SCAN = new RegExp(CURRENCY_TOKEN_SOURCE, 'g')
const CURRENCY_PRESENT = new RegExp(CURRENCY_TOKEN_SOURCE)

function currencyOf(token: string): string {
  if (token === 'A$') return 'AUD'
  if (token === 'C$') return 'CAD'
  return CURRENCY_TOKENS[token] ?? ''
}

/** Every ISO code the sentence names, symbols included, de-duplicated and in a stable order. */
export function currenciesIn(sentence: string): readonly string[] {
  const found = new Set<string>()
  for (const m of sentence.matchAll(CURRENCY_SCAN)) {
    const code = currencyOf(m[0])
    if (code !== '') found.add(code)
  }
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * `g` because it is consumed by `matchAll`; {@link URL_PRESENT} is the non-global twin used by
 * `.test()`. Same `lastIndex` trap as {@link CURRENCY_SCAN}, same reason for splitting them.
 *
 * **The last character class excludes `.,;:!?`.** A URL at the end of a sentence is followed by a full
 * stop, and the naive `[^\s]+` swallows it — which turns `…/v/pkt_x.` into a *different string* from the
 * permitted address and refuses a perfectly correct note. The punctuation class is the difference between
 * a checker that works and one a merchant learns to get round by rewording the last sentence.
 */
const URL_SCAN = /https?:\/\/[^\s<>()[\]"']*[^\s<>()[\]"'.,;:!?]/g
const URL_PRESENT = /https?:\/\//

/**
 * A host-shaped token with no scheme.
 *
 * `countersign.example/v/pkt_x` is not a URL a reader can click by accident, but it is still a link into
 * our infrastructure and a merchant has no reason to print one, so it is refused. Version numbers
 * (`1.17.1`) are excluded because they are all-numeric-and-dots and are not hosts; a dotted token with a
 * letter in its final label is refused.
 */
const BARE_DOMAIN_RE =
  /\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)+\b(?:\/[^\s]*)?/g

function bareDomainsIn(text: string): readonly string[] {
  const out: string[] = []
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    const token = m[0]
    // All-numeric labels (`1.17.1`, `2026.10`) are versions, not hosts.
    if (/^[0-9.]+$/.test(token)) continue
    out.push(token)
  }
  return out
}

/**
 * `PUBLIC_BASE_URL` + `/v/{packetId}` — the **only** link spec §8.15 permits in a note, and the payload
 * §8.18 requires the QR to encode. One function for both, deliberately: they are the same string, and two
 * implementations would eventually disagree — at which point a correct note is refused for a disallowed
 * URL and a QR scans to a 404.
 *
 * Trailing slashes on the base are stripped, because `PUBLIC_BASE_URL` is operator-configured (§6) and a
 * trailing slash would otherwise produce `https://host//v/pkt_x`, which is both a different string from
 * the one the checker was configured with and a 404.
 *
 * `packetId` is interpolated, not validated. It is a `pkt_` ULID from `newId('pkt')`, already URL-safe, and
 * a second validation rule here would be a weaker copy of the type in `packages/core`.
 */
export function publicPacketUrl(baseUrl: string, packetId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/v/${packetId}`
}

// ---------------------------------------------------------------------------
// EC-MER-4: what an assertion may not be used to prove
// ---------------------------------------------------------------------------

/**
 * A guard that keeps a keyword out of an identifier.
 *
 * The drafter eval found this on its first run: an invoice number of `INV-bad-05-notified` was refused as a
 * **notification claim**, because `\bnotified\b` matches inside it — `-` is a non-word character, so both
 * edges of `notified` are word boundaries. The same trap applies to `delivered` inside `SKU-DELIVERED-1` and
 * to `token` inside `access_token`, so all three rule families share this one guard.
 *
 * It is a real hazard, not a theoretical one: invoice numbers, order references and PayPal ids are full of
 * capitalised words, and a checker that reads meaning into one of them refuses filings over a coincidence.
 * **Fail-closed reasoning does not extend to "refuse a correct filing"** — pretending otherwise would make
 * this checker unusable rather than safe, and an unusable checker gets bypassed.
 */
const NOT_AN_IDENTIFIER_BEFORE = '(?<![A-Za-z0-9_-])'
const NOT_AN_IDENTIFIER_AFTER = '(?![A-Za-z0-9_-])'

/** Build a `\b`-free pattern from an alternation, so the identifier guard is applied uniformly. */
function guarded(alternatives: string, flags = 'i'): RegExp {
  return new RegExp(
    `${NOT_AN_IDENTIFIER_BEFORE}(?:${alternatives})${NOT_AN_IDENTIFIER_AFTER}`,
    flags,
  )
}

/**
 * Delivery is a carrier fact. A tracking number the merchant typed is not one.
 *
 * `g` because it is consumed by `matchAll`, which clones the regex and so does not share `lastIndex` — which
 * is why there is no non-global twin to get out of step with it.
 */
const DELIVERY_WORDS_G = guarded(
  'delivered|delivery (?:confirmed|scan|proof|record)|proof of delivery|handed over|received by|' +
    'arrived at|signed for by|left with|courier handed',
  'gi',
)

/** Carrier verification is a carrier fact in the same way. */
const CARRIER_VERIFICATION_WORDS_G = guarded(
  'carrier[- ](?:verified|confirmed|validated)|verified by the carrier|independently verified|' +
    'courier confirmed|carrier scan confirmed|confirmed by the carrier',
  'gi',
)

/**
 * Notification is a **we**-fact, and we hold no artefact for it.
 *
 * There is no `notification:<id>` artefact kind, and inventing one would be the exact failure EC-MER-4
 * warns about: a claim with an artefact that only exists because we typed it. So any sentence asserting that
 * we told the buyer is refused — with or without a marker.
 *
 * **The alternatives are verb phrases, not the bare word "notified".** A bare `notified` was the first
 * version and the drafter eval found it wrong on its first run: the invoice number `INV-bad-05-notified` was
 * refused as a notification claim. Requiring a subject and a verb keeps the rule aimed at the claim it exists
 * to refuse, and `test/citation.test.ts` pins both halves.
 */
const NOTIFICATION_WORDS = guarded(
  'we notified|we (?:emailed|informed|told|alerted) the (?:buyer|customer)|' +
    '(?:buyer|customer) (?:was|were|has been|have been) (?:told|informed|notified)|' +
    'notification (?:sent|emailed|issued)|' +
    'email(?:ed)? (?:was |has been )?sent to the (?:buyer|customer)',
)

// ---------------------------------------------------------------------------
// claimSourcesFor
// ---------------------------------------------------------------------------

/**
 * Derive, deterministically, the set of facts this packet may assert.
 *
 * Pure composition over the same rows `route()` read — no model, no clock, no database. Two properties
 * are load-bearing:
 *
 * 1. **A fact that cannot be stated is absent, not empty.** `rationale.ts` sets this precedent and it
 *    matters here more: an absent claim cannot be cited, so "we have no refund" can never be written as
 *    though it were a value.
 * 2. **Every claim carries its artefact id**, so the packet's "each cited claim with its artefact id"
 *    column (§8.18) is generated rather than transcribed by a human.
 *
 * @param ctx the context `route()` was given.
 * @param decision the decision, for the rule id (§8.15 requires the rule in the packet).
 */
export function claimSourcesFor(
  ctx: DisputeContext,
  decision: LiabilityDecision,
): readonly ClaimSource[] {
  const out: ClaimSource[] = []
  const chain: ChainFacts = ctx.chain ?? {}
  const captureArtefact: ClaimArtefact | null =
    ctx.capture === undefined
      ? null
      : {
          id: `capture:${ctx.capture.paypalCaptureId}`,
          kind: 'capture',
          description: `the PayPal capture ${ctx.capture.paypalCaptureId}`,
        }
  const checkoutArtefact: ClaimArtefact | null =
    ctx.order === undefined
      ? null
      : {
          id: `checkout:${ctx.order.id}`,
          kind: 'checkout',
          description: `the merchant-signed checkout for order ${ctx.order.invoiceId ?? ctx.order.id}`,
        }

  const push = (
    id: string,
    phrase: string,
    artefact: ClaimArtefact,
    support: ClaimSupport,
    instruction: string,
    money?: Money,
  ): void => {
    out.push({
      id,
      phrase,
      artefact,
      support,
      instruction,
      ...(money === undefined ? {} : { money }),
    })
  }

  // --- the rule itself. §8.15: "each has a rule ID shown in the UI and the packet" ------------------
  push(
    'clm_rule',
    decision.ruleId,
    {
      id: 'l2',
      kind: 'l2',
      description: 'the signed mandate and the deterministic rule that decided this dispute',
    },
    'record',
    `State that the deterministic router decided this case under rule ${decision.ruleId}.`,
  )

  // --- money -------------------------------------------------------------------------------------
  if (ctx.capture !== undefined && captureArtefact !== null) {
    push(
      'clm_dispute_amount',
      formatMoneyCode(ctx.dispute.amount),
      captureArtefact,
      'record',
      'State the amount the buyer is disputing.',
      ctx.dispute.amount,
    )
    push(
      'clm_capture_amount',
      formatMoneyCode(ctx.capture.amount),
      captureArtefact,
      'record',
      'State the amount PayPal captured.',
      ctx.capture.amount,
    )
    push(
      'clm_capture_id',
      ctx.capture.paypalCaptureId,
      captureArtefact,
      'record',
      'Quote the PayPal capture id.',
    )
  }

  if (checkoutArtefact !== null && ctx.order !== undefined) {
    push(
      'clm_order_amount',
      formatMoneyCode(ctx.order.amount),
      checkoutArtefact,
      'record',
      'State the total of the merchant-signed order.',
      ctx.order.amount,
    )
    push(
      'clm_custom_id',
      ctx.order.customId,
      checkoutArtefact,
      'record',
      'Quote the order custom_id.',
    )
    if (ctx.order.invoiceId !== undefined) {
      push(
        'clm_invoice_id',
        ctx.order.invoiceId,
        checkoutArtefact,
        'record',
        'Quote the order invoice id.',
      )
    }
  }

  // --- refunds. One claim per refund, so the id and the amount are separately quotable ----------
  for (const [i, r] of completedRefunds(ctx).entries()) {
    const artefact: ClaimArtefact = {
      id: `refund:${r.paypalRefundId}`,
      kind: 'refund',
      description: `PayPal refund ${r.paypalRefundId}`,
    }
    push(
      `clm_refund_amount_${i}`,
      formatMoneyCode(r.amount),
      artefact,
      'record',
      `State that we refunded ${formatMoneyCode(r.amount)}.`,
      r.amount,
    )
    push(`clm_refund_id_${i}`, r.paypalRefundId, artefact, 'record', 'Quote the PayPal refund id.')
    push(
      `clm_refund_at_${i}`,
      formatIstHuman(r.atSec),
      artefact,
      'record',
      'State when the refund completed, in IST.',
    )
  }

  // --- tracking. EC-MER-4 lives here ---------------------------------------------------------------
  for (const s of trackedShipments(ctx)) {
    // Per shipment, not `hasPaypalTracker(ctx)`: that helper answers "did the merchant register *any*
    // tracker", and EC-MER-4 is about *this* parcel. A merchant who registered one tracker and typed a
    // second number must not have the typed one promoted to a record by the registered one.
    const registered = typeof s.paypalTrackerId === 'string' && s.paypalTrackerId !== ''
    const artefact: ClaimArtefact = {
      id: `tracking:${s.paypalTrackerId ?? s.id}`,
      kind: 'tracking',
      description: registered
        ? `PayPal's tracker for ${s.carrier} ${s.trackingNumber}, so PayPal holds the carrier scans`
        : `the tracking number ${s.carrier} ${s.trackingNumber}, typed by the merchant and not independently verified`,
    }
    push(
      `clm_tracking_${s.id}`,
      `${s.carrier} ${s.trackingNumber}`,
      artefact,
      registered ? 'record' : 'assertion',
      registered
        ? `State that this parcel was dispatched with carrier ${s.carrier}, tracking ${s.trackingNumber}. PayPal holds the scans. Do NOT claim it was delivered.`
        : `State that the merchant recorded tracking ${s.carrier} ${s.trackingNumber} for this parcel. This is merchant-asserted: never call it delivered, verified or carrier-confirmed.`,
    )
    if (s.status !== undefined) {
      push(
        `clm_tracking_status_${s.id}`,
        s.status,
        artefact,
        registered ? 'record' : 'assertion',
        `Quote the shipment status exactly as we hold it (${s.status}).`,
      )
    }
  }

  // --- the signed chain ------------------------------------------------------------------------------
  if (chain.iatSec !== undefined) {
    push(
      'clm_mandate_signed_at',
      formatIstHuman(chain.iatSec),
      { id: 'l2', kind: 'l2', description: 'the signed mandate (L2)' },
      'record',
      'State when the buyer signed the mandate, in IST.',
    )
  }
  const chainValid = chain.verifyAtCaptureChainValid === true || chain.verifyNowChainValid === true
  if (chain.verifyAtCaptureChainValid !== undefined || chain.verifyNowChainValid !== undefined) {
    push(
      'clm_chain_verified',
      chainValid ? 'chain verified' : 'chain did not verify',
      { id: 'l3', kind: 'l3', description: 'the L3 that authorised this purchase' },
      'record',
      chainValid
        ? 'State that the signed chain verified. Use the words "chain verified".'
        : 'State that the signed chain did not verify. Use the words "chain did not verify".',
    )
  }
  if (chain.webauthnPresent !== undefined) {
    push(
      'clm_user_verification',
      chain.webauthnPresent ? 'user-verification' : 'no user-verification',
      {
        id: 'l1',
        kind: 'l1',
        description: 'the L1 credential that bound the wallet to the device',
      },
      'record',
      chain.webauthnPresent
        ? 'State that a passkey user-verification was present when the mandate was signed.'
        : 'State that no passkey user-verification was recorded at signing. Never imply one was.',
    )
  }
  if (chain.deviceStatus !== undefined) {
    push(
      'clm_device_status',
      chain.deviceStatus,
      { id: 'l1', kind: 'l1', description: 'the device that signed the mandate' },
      'record',
      'Quote the device status exactly as we hold it.',
    )
  }
  if (chain.deviceStatus === 'LOST' || chain.deviceLostAtSec !== undefined) {
    push(
      'clm_device_reported_lost',
      'reported lost',
      { id: 'l1', kind: 'l1', description: 'the device that signed the mandate' },
      'record',
      'If you must mention the device at all, say it was reported lost. Never describe it as active.',
    )
  }
  if (chain.gateDecision !== undefined) {
    push(
      'clm_gate_decision',
      chain.gateDecision,
      {
        id: `gate:${ctx.dispute.id}`,
        kind: 'gate',
        description: `the signed Gate decision record for this dispute (${chain.gateDecision})`,
      },
      'record',
      'Quote the merchant Gate decision exactly as it was recorded.',
    )
  }

  // --- the disputed lines ---------------------------------------------------------------------------
  const skus = disputedSkus(ctx)
  if (skus.length > 0) {
    push(
      'clm_disputed_lines',
      skus.join(', '),
      checkoutArtefact ?? {
        id: 'l2',
        kind: 'l2',
        description: 'the signed mandate and the deterministic rule that decided this dispute',
      },
      'record',
      'Name the disputed line(s) exactly as our records do.',
    )
  }

  // A claim with an empty phrase would make `PHRASE_NOT_IN_SENTENCE` unreachable for it: `''` is a
  // substring of everything. Dropping it is the fail-closed direction — an uncitable fact stays uncitable.
  return out.filter((c) => c.phrase.length > 0)
}

// ---------------------------------------------------------------------------
// checkCitations
// ---------------------------------------------------------------------------

/** Markers removed, whitespace tidied, and the gap a marker left closed. */
export function stripMarkers(sentence: string): string {
  return (
    sentence
      .replace(MARKER, '')
      .replace(/\s+/g, ' ')
      // `The rule was R-UNAUTH-1 [[clm_rule]].` must file as `…R-UNAUTH-1.`, not `…R-UNAUTH-1 .`. A visible
      // gap before a full stop is the kind of detail a merchant notices and a judge quotes.
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .trim()
  )
}

/**
 * Check a draft against the claims it is allowed to make. **Pure**, and the only thing that decides
 * whether a note is filed.
 *
 * @param draft anything with a `notes` field — a `Draft`, or `{ notes }` from a test.
 * @param claims `claimSourcesFor(ctx, decision)`. An empty list blocks every non-boilerplate sentence,
 *   which is the correct answer: a packet with no citable facts may not make claims.
 * @param options `allowedUrl` is the single permitted link; omit it to permit none.
 */
export function checkCitations(
  draft: { readonly notes: string },
  claims: readonly ClaimSource[],
  options: CitationOptions = {},
): CitationVerdict {
  const notes = draft.notes
  const maxChars = Math.min(options.maxChars ?? NOTES_MAX_CHARS, NOTES_MAX_CHARS)
  const allowedUrl = options.allowedUrl
  const byId = new Map(claims.map((c) => [c.id, c]))

  const problems: CitationProblem[] = []
  const citations: Citation[] = []
  const cited: string[] = []

  // --- the whole-string checks, first, so a length or URL failure is reported before per-sentence ----
  if (notes.trim().length === 0) {
    return verdict(
      false,
      [problem('EMPTY_NOTES', notes, 'The note is empty. PayPal requires at least one character.')],
      [],
      [],
    )
  }
  if (notes.length > maxChars && options.ignoreLength !== true) {
    problems.push(
      problem(
        'TOO_LONG',
        `${notes.length} characters`,
        `The note is ${notes.length} characters; PayPal caps this field at ${maxChars}.`,
      ),
    )
  }

  problems.push(...urlProblems(notes, allowedUrl))

  // --- sentence by sentence -------------------------------------------------------------------------
  for (const raw of splitSentences(notes)) {
    const markers = [...raw.matchAll(MARKER)].map((m) => m[1] ?? '')
    const body = stripMarkers(raw)

    // Notification has no artefact kind at all, so it is refused with or without a marker.
    if (NOTIFICATION_WORDS.test(body)) {
      problems.push(
        problem(
          'FORBIDDEN_DERIVATION',
          raw,
          `"${body}" claims the buyer was notified. We hold no artefact that any notification was sent, ` +
            'so this cannot be filed. Remove it or cite an artefact that exists.',
        ),
      )
      // A blocked sentence must not contribute citations: those would be recorded as filed.
      continue
    }

    // A sentence must not carry a half-written or near-miss marker: `[[clm_x`, `[[Clm_X]]` and
    // `[[clm_dispute.amount]]` are all refusals. **Checked before the boilerplate branch**, because
    // without it a near-miss marker matches no claim, the sentence looks uncited, and the operator is told
    // "no marker" when the truth is "a malformed one" — and the fix for those two is not the same.
    if (MARKER_SHAPE.test(body)) {
      problems.push(
        problem(
          'MALFORMED_MARKER',
          raw,
          'This contains `[[` or `]]` that is not a well-formed marker. A marker is exactly ' +
            '`[[lower_case_id]]`, with no dots and no capitals.',
        ),
      )
      continue
    }

    if (markers.length === 0) {
      if (!isBoilerplate(body, allowedUrl)) {
        problems.push(
          problem(
            'UNCITED_SENTENCE',
            raw,
            `No [[claim_id]] marker, and this is not one of the ${BOILERPLATE_SENTENCES.length} allowed ` +
              'boilerplate sentences. Every sentence that asserts something needs a claim marker.',
          ),
        )
      }
      continue
    }

    let usable = true
    for (const id of markers) {
      const source = byId.get(id)
      if (source === undefined) {
        problems.push(
          problem(
            'UNKNOWN_CLAIM_ID',
            raw,
            `[[${id}]] is not a claim this packet may assert. The claims you may use are: ` +
              `${claims.map((c) => c.id).join(', ')}.`,
          ),
        )
        usable = false
        continue
      }

      if (!containsPhrase(body, source.phrase)) {
        problems.push(
          problem(
            'PHRASE_NOT_IN_SENTENCE',
            raw,
            `[[${id}]] is backed by ${source.artefact.description}, which says "${source.phrase}". That ` +
              `text does not appear in this sentence, so the citation does not support what is written.`,
          ),
        )
        usable = false
      }

      if (source.money !== undefined) {
        // **One currency per sentence, and it must be the cited claim's.** Deliberately narrow rather than
        // clever: a sentence naming two currencies is refused however the amounts are arranged, because at
        // that point neither the reader nor the checker can say which figure is in which currency. §0 rule 9
        // is integer minor units plus a code, and a sentence with two codes has multiplied its own money.
        const named = currenciesIn(body)
        if (named.length > 0 && !named.every((c) => c === source.money?.currency)) {
          problems.push(
            problem(
              'CURRENCY_MISMATCH',
              raw,
              `[[${id}]] is an amount in ${source.money.currency}, but this sentence names ` +
                `${named.join(', ')}. The right figure in the wrong currency is not the same fact, and the ` +
                'Gate refuses to convert. A sentence names one currency; put the second amount in its own ' +
                'sentence.',
            ),
          )
          usable = false
        }
      }
    }

    // --- EC-MER-4, as one rule ------------------------------------------------------------------------
    //
    // **A delivery or carrier-verification word may only appear if some cited claim's own phrase contains
    // that word.** It has the same shape as the currency rule — the right figure in the wrong currency is
    // refused — and it gets both halves of the edge case right:
    //
    //  - `"was delivered by DHL JD0002000031 [[clm_tracking_shp_1]]"` → "delivered" is in no phrase →
    //    refused, **whether or not** the tracker is registered at PayPal, because a registered tracker means
    //    PayPal holds the scans, not that anything was delivered.
    //  - `"status is DELIVERED [[clm_tracking_status_shp_1]]"` → "DELIVERED" *is* the phrase we hold, so
    //    quoting our own row is reporting rather than deriving. Refusing that would make our stored status
    //    uncitable, which is worse than the thing EC-MER-4 guards against — and it is exactly the label
    //    EC-MER-4 asks the packet to carry: tracking is labelled merchant-asserted, and the packet makes no
    //    carrier-verification claim.
    const phrases = markers.map((id) => byId.get(id)?.phrase ?? '').map((p) => p.toLowerCase())
    for (const word of [
      ...body.matchAll(DELIVERY_WORDS_G),
      ...body.matchAll(CARRIER_VERIFICATION_WORDS_G),
    ]) {
      const said = (word[0] ?? '').toLowerCase()
      if (phrases.some((p) => p.includes(said))) continue
      const asserted = markers.some((id) => byId.get(id)?.support === 'assertion')
      problems.push(
        problem(
          'FORBIDDEN_DERIVATION',
          raw,
          `"${word[0]}" is a carrier fact and no claim in this sentence records it${
            asserted
              ? '. The claim behind this sentence is merchant-asserted, and an assertion is not evidence (EC-MER-4).'
              : '. We hold no carrier record for it, so it cannot be asserted (EC-MER-4).'
          }`,
        ),
      )
      usable = false
      break
    }

    if (usable) {
      for (const id of markers) {
        const source = byId.get(id)
        if (source === undefined) continue
        if (!cited.includes(id)) cited.push(id)
        citations.push({
          claimId: id,
          sentence: body,
          artefact: source.artefact,
          support: source.support,
        })
      }
    }
  }

  return verdict(
    problems.length === 0,
    problems,
    citations,
    cited,
    claims.map((c) => c.id).filter((id) => !cited.includes(id)),
  )
}

// ---------------------------------------------------------------------------
// The truncation that is never silent
// ---------------------------------------------------------------------------

/** The fixed notice `truncateNotes` appends. A member of {@link BOILERPLATE_SENTENCES}, and constant. */
export const TRUNCATION_NOTICE =
  "Some sentences were omitted to fit PayPal's limit on this field; the omitted text is in the attached packet PDF."

export interface TruncationReport {
  /** Length of the model's text before truncation. */
  readonly writtenChars: number
  /** Length of the text actually kept, notice included. */
  readonly keptChars: number
  /** Whole sentences dropped. Never a partial one — see below. */
  readonly droppedSentences: number
  /** The exact string appended. Constant, so it never needs a citation. */
  readonly notice: string
}

/**
 * Fit a note inside PayPal's 2000-character cap **by dropping whole sentences and saying so**.
 *
 * Why sentence-at-a-time and not `.slice()`: a note that ends mid-claim is still read as a claim. If the
 * cut lands inside "the buyer was notified on [[clm_…]]", the fragment that survives still asserts
 * notification, the fragment's marker is gone, and the checker — correctly — blocks it. That is a
 * rejected filing, spent response, and a human woken up to debug our truncation rather than their
 * dispute. §8.15's own limit is on the field; nothing says the cut has to be a character count.
 *
 * Why the notice is a **constant** and not `"[N of M characters written]"`: a digit in an uncited
 * sentence is an uncitable digit, so an informative truncation notice would itself fail the checker.
 * The numbers live on {@link TruncationReport} instead — returned, logged, and rendered in S-18 — and the
 * note itself gets a fixed, citable sentence saying that sentences were omitted and where they are.
 *
 * @returns the (possibly unchanged) text and a report that is `null` when nothing was dropped.
 */
export function truncateNotes(
  text: string,
  maxChars: number = NOTES_MAX_CHARS,
): { readonly notes: string; readonly report: TruncationReport | null } {
  const cap = Math.min(maxChars, NOTES_MAX_CHARS)
  if (text.length <= cap) return { notes: text, report: null }
  const budget = cap - TRUNCATION_NOTICE.length - 1
  const sentences = splitSentences(text)
  const kept: string[] = []
  let used = 0
  for (const s of sentences) {
    if (used + s.length + 1 > budget) break
    kept.push(s)
    used += s.length + 1
  }
  const notes = kept.length === 0 ? TRUNCATION_NOTICE : `${kept.join(' ')} ${TRUNCATION_NOTICE}`
  return {
    notes,
    report: {
      writtenChars: text.length,
      keptChars: notes.length,
      droppedSentences: sentences.length - kept.length,
      notice: TRUNCATION_NOTICE,
    },
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Verbatim containment, with two allowances and a stated reason for each.
 *
 * - **Whitespace collapsed**, so a line break inside `USD 129.99` does not read as an absent phrase. The
 *   note is plain text; a hard-wrapped sentence is still the same sentence.
 * - **Case-insensitive**, because `SHIPPED` and `shipped` are the same artefact status. Everything else
 *   is exact: no normalisation of amounts, no stripping of punctuation, no digit matching.
 */
function containsPhrase(sentence: string, phrase: string): boolean {
  const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim()
  return normalise(sentence).toLowerCase().includes(normalise(phrase).toLowerCase())
}

function urlProblems(notes: string, allowedUrl: string | undefined): CitationProblem[] {
  const out: CitationProblem[] = []
  const urls = [...notes.matchAll(URL_SCAN)].map((m) => m[0])
  let allowedCount = 0
  for (const url of urls) {
    if (allowedUrl !== undefined && url === allowedUrl) {
      allowedCount += 1
      continue
    }
    out.push(
      problem(
        'DISALLOWED_URL',
        url,
        allowedUrl === undefined
          ? "This note contains a URL. The only link a note may carry is the packet's own public verifier address, which this call was not given."
          : `The only link a note may carry is ${allowedUrl}. This one is not it — a tracking-parameterised variant, a bare domain or a third-party link is all refused.`,
      ),
    )
  }
  if (allowedCount > 1) {
    out.push(
      problem(
        'DUPLICATE_URL',
        allowedUrl ?? '',
        `The permitted address appears ${allowedCount} times. One link, once.`,
      ),
    )
  }
  const bare = bareDomainsIn(allowedUrl === undefined ? notes : notes.split(allowedUrl).join(' '))
  for (const token of bare) {
    out.push(
      problem(
        'DISALLOWED_URL',
        token,
        `"${token}" is a host name with no scheme. A note carries one link — the packet's public verifier address — and nothing else.`,
      ),
    )
  }
  return out
}

function problem(code: CitationProblemCode, sentence: string, detail: string): CitationProblem {
  return { code, sentence, detail }
}

function verdict(
  ok: boolean,
  problems: readonly CitationProblem[],
  citations: readonly Citation[],
  citedClaimIds: readonly string[],
  unusedClaimIds: readonly string[] = [],
): CitationVerdict {
  return { ok, problems, citations, citedClaimIds, unusedClaimIds }
}

/**
 * One line per problem, for `Draft.blocked` and for S-18.
 *
 * The shape is fixed: `[code] "<the sentence>" — <why>`. A human deciding whether to file a manually
 * edited note needs the offending text quoted back, and the code is what they paste into a support
 * request.
 */
export function formatProblems(problems: readonly CitationProblem[]): readonly string[] {
  return problems.map((p) => `[${p.code}] "${p.sentence}" — ${p.detail}`)
}

/** Exported so `test/citation.test.ts` can assert the closed set has no unhandled member. */
export const CITATION_PROBLEM_CODES: readonly CitationProblemCode[] = [
  'EMPTY_NOTES',
  'TOO_LONG',
  'MALFORMED_MARKER',
  'UNKNOWN_CLAIM_ID',
  'UNCITED_SENTENCE',
  'PHRASE_NOT_IN_SENTENCE',
  'CURRENCY_MISMATCH',
  'FORBIDDEN_DERIVATION',
  'DISALLOWED_URL',
  'DUPLICATE_URL',
]
