/**
 * The **anchors**: what §7.3's bundle itself proves about this purchase, read out of the artefacts that carry
 * a signature.
 *
 * ## Why this file exists
 *
 * A digest is only a binding against something the forger cannot recompute. `bundle_hash` and `custom_id` are
 * both recomputable by anyone holding the document, so neither of them can answer "is this packet about *this*
 * purchase" — only the signature-bearing artefacts can, because a forger cannot re-sign an L2, a price lock or
 * a Gate decision record.
 *
 * So this file reads the facts that **are** under a signature out of those artefacts:
 *
 * | Anchor | Read from | Signature that covers it |
 * |---|---|---|
 * | the price that was locked | `checkout_jwt` → `cart.total` | the merchant key (§8.3) |
 * | the merchant that was paid | `checkout_jwt` → `merchant.id` | the merchant key (§8.3) |
 * | the payee the agent named | `l3a` → `mandate.payment.1` → `payee.id` | the agent key (§8.3) |
 * | the window the chain exists in | `iat` on all five tokens | five independent signatures |
 * | the monetary limits the buyer signed | `l2` → `mandate.payment.*` constraints | the issuer key (§8.8) |
 *
 * Everything here is **decode only** — never verification. Whether those signatures are valid is
 * `verify-view.ts`'s job and vi-service's; this module exists so the binding checks compare claims that
 * something has already signed, rather than comparing a claim with itself.
 *
 * ## What deliberately cannot be read here, and why that is a finding rather than a gap
 *
 * §8.10's decision record asserts `att` (the attempt) and `mdt` (the mandate). **Neither identifier appears in
 * any signed artefact in §7.3's bundle.** The L1's `sub` is the user, the L2 carries no mandate id, L3a/L3b
 * carry no attempt id, the price lock names only a `checkout_id`, and the Gate record is the sole place the two
 * ids exist. There is therefore nothing for this package to compare them against, and `verify-view.ts` says so
 * on the page as a `WARN` rather than passing them. Same story for `readback`, which is a `mandates` column
 * written after the mandate was signed and appears in no signature at all.
 *
 * Fixing either needs a change **outside** this package — see `README.md`, "What the read-back cannot be bound
 * to", for the precise, smallest change and why no local workaround is honest.
 */

import { decodeCheckoutJwt } from '@countersign/gate'
import { fromPayPalValue, isCurrency, MINOR_DIGITS, type Currency } from '@countersign/core'

import { decodeSdJwt, resolveSdJwt } from './bundle'

/** A money claim as one artefact states it: integer minor units plus the ISO-4217 code it is in. */
export interface MoneyClaim {
  readonly minor: bigint
  readonly currency: string
}

/** The price and merchant the merchant-signed price lock commits to. §8.3, `apps/vi`'s `checkout_jwt.py`. */
export interface PriceLockAnchor {
  readonly total: MoneyClaim
  readonly merchantId: string | null
}

/** What the agent-key-signed L3a says was authorised and to whom. §8.3, `apps/vi`'s `l3.py`. */
export interface L3aAnchor {
  readonly payment: MoneyClaim
  readonly payeeId: string | null
  /** The `transaction_id` L3a committed to — L3b's `checkout_hash` for the same cart. */
  readonly transactionId: string | null
}

/** Every anchor above, with `null` for whatever this bundle could not be read for. */
export interface ChainAnchors {
  readonly priceLock: PriceLockAnchor | null
  readonly l3a: L3aAnchor | null
  /** `null` when no token in the bundle carried a numeric `iat`. */
  readonly iatWindow: { readonly earliest: number; readonly latest: number } | null
}

/** The five tokens §7.3 carries, in the order the page lists them. */
const CHAIN_TOKENS = ['l1', 'l2', 'l3a', 'l3b', 'checkout_jwt'] as const

/**
 * Read every anchor this bundle supports, in one pass.
 *
 * Each reader is **independent and total**: a token that will not decode yields `null` for the facts it would
 * have supplied and does not stop the others. A page that reported "nothing could be read" because one token
 * was malformed would be a page that hid a failure, and this whole exercise exists to stop the page hiding one.
 */
export function readChainAnchors(bundle: Readonly<Record<string, unknown>>): ChainAnchors {
  return {
    priceLock: readPriceLock(bundle),
    l3a: readL3a(bundle),
    iatWindow: readIatWindow(bundle),
  }
}

// ---------------------------------------------------------------------------
// The price lock
// ---------------------------------------------------------------------------

/**
 * `checkout_jwt` → `cart.total` and `merchant.id`.
 *
 * `apps/vi/src/vi_service/checkout_jwt.py` puts the money at `cart.total = {amount_minor, currency_code}` and
 * the merchant at the top level (and again inside `cart`). A top-level `total` is accepted as a fallback
 * because an older capture had it there; `null` is returned when neither is present, which the callers report
 * as `SKIPPED` with the reason rather than as a pass.
 *
 * **Decoded, never verified.** The merchant key's signature over this token is checked by vi-service and by the
 * generated `verify.py`; this only reads claims those signatures cover.
 */
function readPriceLock(bundle: Readonly<Record<string, unknown>>): PriceLockAnchor | null {
  const jwt = readString(bundle['checkout_jwt'])
  if (jwt === null) return null
  const decoded = decodeCheckoutJwt(jwt)
  if (!decoded.ok) return null
  const claims = decoded.claims
  const cart = asRecord(claims['cart'])
  const total = moneyClaim(cart === null ? null : cart['total']) ?? moneyClaim(claims['total'])
  if (total === null) return null
  const merchant =
    asRecord(claims['merchant']) ?? (cart === null ? null : asRecord(cart['merchant']))
  return { total, merchantId: readString(merchant === null ? null : merchant['id']) }
}

// ---------------------------------------------------------------------------
// The agent authorisation
// ---------------------------------------------------------------------------

/**
 * `l3a` → the `mandate.payment.1` disclosure → `payment_amount` and `payee.id`.
 *
 * **Resolved, not merely decoded**, for the same reason `checkoutBindingCheck` resolves L3b: the mandate sits
 * behind a `{"...": digest}` reference in `delegate_payload`, so reading the payload alone finds no `vct` and
 * the page would report "the agent authorised nothing" for every untampered packet. That is a false alarm on
 * the one page nobody may cry wolf on.
 */
function readL3a(bundle: Readonly<Record<string, unknown>>): L3aAnchor | null {
  const token = readString(bundle['l3a'])
  if (token === null) return null
  const decoded = resolveSdJwt(token)
  if (!decoded.ok) return null
  const claim = findByVct(decoded.payload, 'mandate.payment.1', 0)
  if (claim === null) return null
  const payment = moneyClaim(claim['payment_amount'])
  if (payment === null) return null
  const payee = asRecord(claim['payee'])
  return {
    payment,
    payeeId: readString(payee === null ? null : payee['id']),
    transactionId: readString(claim['transaction_id']),
  }
}

/**
 * The first node carrying `vct: name`, walking `delegate_payload` and any nested wrapper, depth-limited.
 *
 * Recursive because a key-bound L3 nests its payment mandate one level inside a key-confirmation wrapper, and a
 * flat scan finds nothing there — which again reads as "authorised nothing" rather than as "could not read".
 */
function findByVct(node: unknown, name: string, depth: number): Record<string, unknown> | null {
  if (depth > 6) return null
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findByVct(entry, name, depth + 1)
      if (found !== null) return found
    }
    return null
  }
  const record = asRecord(node)
  if (record === null) return null
  if (record['vct'] === name) return record
  return findByVct(record['delegate_payload'], name, depth + 1)
}

// ---------------------------------------------------------------------------
// The chain's own time window
// ---------------------------------------------------------------------------

/**
 * The earliest and latest `iat` across every token in the bundle.
 *
 * This is the *one* time window no signature in §7.3 can lie about on its own: five artefacts, five issuers,
 * all of which had to exist for a purchase to happen at all. A Gate record whose `iat` falls outside it is
 * naming a decision that was not part of this transaction — a **record from another attempt**, which is the
 * substitution the previous audit demonstrated and which a "was the signature valid?" question cannot see,
 * because a valid signature over the wrong transaction is still the wrong transaction.
 *
 * `null` when no token carried a numeric `iat`, and the caller then reports `SKIPPED` rather than guessing.
 */
function readIatWindow(bundle: Readonly<Record<string, unknown>>): ChainAnchors['iatWindow'] {
  let earliest: number | null = null
  let latest: number | null = null
  for (const member of CHAIN_TOKENS) {
    const payload = payloadOf(bundle[member])
    if (payload === null) continue
    const iat = payload['iat']
    if (typeof iat !== 'number' || !Number.isFinite(iat)) continue
    if (earliest === null || iat < earliest) earliest = iat
    if (latest === null || iat > latest) latest = iat
  }
  return earliest === null || latest === null ? null : { earliest, latest }
}

/** A JWS/SD-JWT payload as an object, without verifying anything. `null` when it will not decode. */
function payloadOf(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0) return null
  if (token.split('.').length === 3) {
    const decoded = decodeSdJwt(token)
    return decoded.ok ? decoded.payload : null
  }
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The read-back
// ---------------------------------------------------------------------------

/**
 * §8.8's fixed first line: `packages/compiler/src/readback.ts::READBACK_HEADER`.
 *
 * `readBack()` pushes it first, unconditionally, before any constraint line. So a stored read-back that does
 * **not** begin with this string was not produced by the compiler from a signed mandate — it was typed.
 *
 * ### What this is, and what it is not
 *
 * It is a **witness**, not a binding. A forger who reads this file prepends the header and the check is
 * defeated; only a signature would survive that. It earns its place because the alternative is a page that
 * prints invented consent with a green tick, and because it is a claim that is *exactly* true rather than
 * approximately true. The page says so in as many words, because a reader must be able to tell a witness from
 * a binding.
 *
 * Duplicated rather than imported: `@countersign/compiler` is not a dependency of this package, and adding one
 * is a `package.json` change this work package does not own (AGENTS.md rule 8). The two must agree, and
 * `test/binding.test.ts` asserts that agreement by importing the original **by relative path** — the same
 * technique `test/verify.test.ts` already uses for `publicPacketUrl`.
 */
export const READBACK_HEADER = '**What you are authorising**'

/** `true` when `value` is a string beginning with {@link READBACK_HEADER}. */
export function isCompilerReadback(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith(READBACK_HEADER)
}

/**
 * The monetary ceiling the **signed** L2 places on this mandate.
 *
 * Collected from the two constraint types §8.8 renders as money — `mandate.payment.amount_range` (per payment)
 * and `mandate.payment.budget` (in total, D19's network-enforced one) — by reading the L2's *resolved*
 * disclosures, so the numbers are the ones the issuer signed.
 *
 * Three outcomes, and the middle one is a refusal rather than a guess:
 *
 * | Result | Reading |
 * |---|---|
 * | `one` | exactly one currency is capped; `max` is the largest cap in it. |
 * | `ambiguous` | the mandate names caps in more than one currency, so a figure printed in the text cannot be attributed to one of them without guessing which symbol means what. |
 * | `none` | the signed mandate places no monetary cap, so there is nothing for a stated cap to contradict. |
 */
export type MonetaryCeiling =
  | { readonly kind: 'one'; readonly currency: Currency; readonly max: bigint }
  | { readonly kind: 'ambiguous'; readonly currencies: readonly string[] }
  | { readonly kind: 'none' }

const CAPPED_CONSTRAINT_TYPES = new Set(['mandate.payment.amount_range', 'mandate.payment.budget'])

/**
 * The largest spending limit the buyer signed, or why it cannot be stated.
 *
 * A single unreadable constraint is **not** a reason to report no ceiling: the walk collects every limit it can
 * read and the ambiguity is reported only when the currencies genuinely disagree, because reading three of four
 * constraints and calling the result "no cap" would be the silent narrowing this page exists to avoid.
 */
export function readMonetaryCeiling(bundle: Readonly<Record<string, unknown>>): MonetaryCeiling {
  const token = readString(bundle['l2'])
  if (token === null) return { kind: 'none' }
  const decoded = resolveSdJwt(token)
  if (!decoded.ok) return { kind: 'none' }
  const byCurrency = new Map<Currency, bigint>()
  for (const constraint of collectConstraints(decoded.payload, 0)) {
    const type = constraint['type']
    if (typeof type !== 'string' || !CAPPED_CONSTRAINT_TYPES.has(type)) continue
    const currency = constraint['currency']
    const max = constraint['max']
    if (!isCurrency(currency)) continue
    const minor = integerOf(max)
    if (minor === null) continue
    const seen = byCurrency.get(currency)
    byCurrency.set(currency, seen === undefined || minor > seen ? minor : seen)
  }
  if (byCurrency.size === 0) return { kind: 'none' }
  if (byCurrency.size > 1) return { kind: 'ambiguous', currencies: [...byCurrency.keys()].sort() }
  const only = [...byCurrency.entries()][0]
  /* c8 ignore next -- unreachable: `size > 0` is established above, so the entry always exists. */
  if (only === undefined) return { kind: 'none' }
  return { kind: 'one', currency: only[0], max: only[1] }
}

/** Every `constraints[ … ]` entry under `delegate_payload`, depth-limited and order-preserving. */
function collectConstraints(node: unknown, depth: number): Record<string, unknown>[] {
  if (depth > 6) return []
  if (Array.isArray(node)) return node.flatMap((entry) => collectConstraints(entry, depth + 1))
  const record = asRecord(node)
  if (record === null) return []
  const out: Record<string, unknown>[] = []
  const constraints = record['constraints']
  if (Array.isArray(constraints)) {
    for (const entry of constraints) {
      const constraint = asRecord(entry)
      if (constraint !== null) out.push(constraint)
    }
  }
  return [...out, ...collectConstraints(record['delegate_payload'], depth + 1)]
}

/**
 * A money figure, identified by its **currency symbol**.
 *
 * ### Why the symbol and not a keyword like `spend`
 *
 * §8.8 renders every amount through `formatMoney`, which always emits the symbol — so a symbol-prefixed
 * decimal is money *by the renderer's own rule*, wherever it appears. The first version of this reader instead
 * scanned only lines beginning with `Spend`, which is where the four amount templates start, and the forged
 * text **"You may spend up to $9,999,999 at any merchant"** walked straight past it: not a template line, so
 * not a cap, so `SKIPPED`. That is the exact substitution this check exists to catch, and a discriminator
 * tuned to the *format* was defeated by a change of *wording*.
 *
 * Scanning symbols instead means the check depends on how money is written, not on how a sentence is
 * constructed — which is the property that survives an adversary choosing their own phrasing.
 *
 * ### What it deliberately excludes
 *
 * Plain numbers with no symbol: the expiry date, the item quantity in `Buy at least **1** of …`, and the
 * preference values. Those are not money, and treating a size of `10` or a year of `2027` as an allowance is
 * how a check like this starts crying wolf.
 */
const MONEY_FIGURE = /(?:US\$|A\$|C\$|[$€£₹¥])\s*(\d+(?:,\d{3})*)(?:\.(\d+))?(?!\d|,|\.\d)/gu

/**
 * Every money figure the read-back states, in integer minor units of `currency`.
 *
 * ### Refusing a partial read, and why that matters more than being permissive
 *
 * Three ways a figure here is **not read**, each because reading it would put a wrong number in front of a
 * reader:
 *
 * 1. **Digit grouping that is not thousands.** The pattern requires `,\d{3}` throughout. `₹9,99,999` is
 *    lakh-grouped — something a person writes and `formatMoney` never emits — and a permissive reader takes the
 *    `₹9` and reports **900 minor units**, a number that is both wrong and small enough to pass a ceiling check.
 *    The negative lookahead rejects the truncated match entirely instead.
 * 2. **More decimal places than the currency has.** `formatMoney` never produces one, so its presence means the
 *    text did not come from the renderer — which `readback_rendered` reports. Rounding it here would silently
 *    invent an allowance.
 * 3. **A figure we cannot parse at all.** Reported by omission, never as a pass.
 *
 * The figures are all attributed to the *signed chain's* currency, because that is the only currency this
 * bundle can adjudicate. A symbol belonging to another currency cannot be re-expressed without a rate, and
 * inventing one would be a float — so a `$` figure is read against whatever the signed mandate says, and a
 * mismatched symbol is the adversary's problem to solve with something this reader will accept.
 */
export function readStatedCaps(readback: unknown, currency: Currency): readonly bigint[] {
  if (typeof readback !== 'string') return []
  const digits = MINOR_DIGITS[currency]
  const out: bigint[] = []
  for (const match of readback.matchAll(MONEY_FIGURE)) {
    const fraction = match[2] ?? ''
    if (fraction.length > digits) continue
    // `digits` is 0 for JPY, and `${n}.` is not a plain decimal — so the point is omitted rather than left
    // dangling. `formatMoney({minor: 500n})` is "¥500", and a reader that insisted on two decimals would report
    // "no figure" on every Japanese read-back.
    const whole = (match[1] ?? '').replace(/,/g, '')
    const plain = digits === 0 ? whole : `${whole}.${fraction.padEnd(digits, '0')}`
    try {
      out.push(fromPayPalValue(plain, currency).minor)
    } catch {
      // Not a plain decimal, so nothing to compare. Reported by omission, never as a pass.
    }
  }
  return out
}

/** The minor digits `currency` has, as a plain string — used in the page's sentences about a stated cap. */
export function minorDigitsOf(currency: Currency): 0 | 2 {
  return MINOR_DIGITS[currency]
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

/**
 * A money object as {@link MoneyClaim}, or `null`.
 *
 * ### Two spellings, because two issuers write them
 *
 * - the **price lock** (`apps/vi/src/vi_service/checkout_jwt.py`) writes
 *   `{"amount_minor": …, "currency_code": …}` — PayPal's own field names;
 * - the **L3a payment authorisation** (`apps/vi/src/vi_service/l3.py`) writes
 *   `{"amount": …, "currency": …}`.
 *
 * Both are read because the whole point of this file is to compare independently-signed artefacts against each
 * other, and a reader that only understood one spelling would silently drop one of the two anchors — reporting
 * `SKIPPED` where it could have reported `FAIL`. Each is preferred over the other, so a token carrying both is
 * read as the issuer that wrote it intends.
 */
function moneyClaim(value: unknown): MoneyClaim | null {
  const record = asRecord(value)
  if (record === null) return null
  const minor = integerOf(record['amount_minor']) ?? integerOf(record['amount'])
  const currency = record['currency_code'] ?? record['currency']
  if (minor === null || typeof currency !== 'string' || currency.length === 0) return null
  return { minor, currency }
}

/**
 * An integer, as a `bigint`, or `null`.
 *
 * `bigint` only: money is integer minor units end to end (§0, EC-FX-6) and a float here would be a rounding
 * decision made silently. A non-integer is reported as unreadable rather than truncated.
 */
function integerOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value)
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
