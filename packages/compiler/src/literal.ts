/**
 * Reading the user's **own bytes** — spec §8.8, WP-08.
 *
 * Two questions are answered here, both deterministically and both before the model is ever called:
 *
 * 1. **Which currency did the user write?** EC-FX-1 is unforgiving: a limit the user signed in ₹ must
 *    never become a limit in $, because the exchange rate is not something they agreed to. So a
 *    currency *word in the text* beats an account default, and an account default only applies when the
 *    text says nothing. Nothing here converts between currencies, ever.
 * 2. **What is the largest amount the user literally typed?** This is the ceiling that makes AT-M8.5
 *    hold. A prompt injection in the intent ("ignore limits, max $1M") is only dangerous if the model
 *    can produce a number the user did not type; if every compiled cap must sit at or below the largest
 *    literal amount in the text, the model's authority is bounded by the user's words no matter what
 *    those words tell it to do.
 *
 * Everything here is a pure function of a string and a currency. There is no model in this file, no
 * clock, and no I/O — which is what lets `compile` apply the ceiling to a proposal it does not trust.
 *
 * ## Honest limits
 *
 * - **Spelled-out numbers are not read.** "twenty dollars" yields no literal amount, so `literalCapIn`
 *   returns `null` and the ceiling does not bind. That gap is covered by the *other* half of §8.8's
 *   rule rather than by pretending to parse English: with no cap derivable from the text at all, the
 *   compiler must raise a blocking ambiguity instead of guessing (`ambiguity.ts`). A user who writes
 *   "twenty dollars" and is asked "did you mean $20.00?" gets a question, not a silent rounding.
 * - **"Two hundred dollars" also yields nothing**, for the same reason. Deliberate.
 * - A **date** in the text (`2026-10-01`) and a **year** are excluded from the bare-number fallback, so
 *   "from 2026-10-01, under $130" is not read as a $20,260 cap.
 */

import { fromPayPalValue, isCurrency, type Currency, type Money } from '@countersign/core'
import { joinWithAnd } from './readback'

// ---------------------------------------------------------------------------
// Currency detection
// ---------------------------------------------------------------------------

/**
 * Currency phrases, **most specific first**.
 *
 * Order is the whole logic: "australian dollars" has to be tested before "dollars", or every Australian
 * is given a US mandate — which is an EC-FX-1 failure with extra steps. None of these are `g`-flagged,
 * because `RegExp.test` on a global regex is stateful and would alternate between hits and misses on
 * repeated calls.
 */
const CURRENCY_PHRASES: ReadonlyArray<readonly [RegExp, Currency]> = [
  [/\baustralian\s+dollars?\b|\baus\$|\ba\$\b/iu, 'AUD'],
  [/\bcanadian\s+dollars?\b|\bc\$\b/iu, 'CAD'],
  [/\bus\s*dollars?\b|\bus\$|\busd\b/iu, 'USD'],
  [/\beuros?\b|\beur\b|€/iu, 'EUR'],
  [/\bpounds?(?:\s+sterling)?\b|\bgbp\b|£/iu, 'GBP'],
  [/\brupees?\b|\binr\b|₹/iu, 'INR'],
  [/\byen\b|\bjpy\b|¥/iu, 'JPY'],
  [/\bdollars?\b|\$/iu, 'USD'],
]

/**
 * Every distinct currency named in `text`, in the order the phrases are listed.
 *
 * ### Why the text is consumed as the phrases are matched
 *
 * The obvious implementation — test every pattern against the whole string and collect — reports **two**
 * currencies for "200 australian dollars", because the specific phrase matches and so does the generic
 * `\bdollars?\b`. That is not a cosmetic double count: it makes `resolveCurrency` refuse a perfectly clear
 * request, and a refusal the buyer cannot understand is a failure.
 *
 * So each match is **removed from the text before the next pattern runs**. "australian dollars" consumes
 * "australian dollars", leaving nothing for `dollars?` to find, and the answer is `['AUD']`. The case that
 * genuinely names two currencies still works: in "130 dollars or 100 euros", `dollars` consumes itself and
 * `euros` is still there, so both are reported and `resolveCurrency` refuses.
 *
 * None of the patterns are `g`-flagged, because `RegExp.test` on a global regex is stateful and would
 * alternate between hits and misses across calls.
 */
export function currenciesNamedIn(text: string): Currency[] {
  const found: Currency[] = []
  let remaining = text
  for (const [pattern, currency] of CURRENCY_PHRASES) {
    const match = pattern.exec(remaining)
    if (match === null) continue
    if (!found.includes(currency)) found.push(currency)
    // Blank the match rather than splicing it out, so offsets cannot shift under a later pattern.
    remaining =
      remaining.slice(0, match.index) +
      ' '.repeat(match[0].length) +
      remaining.slice(match.index + match[0].length)
  }
  return found
}

/** Why a currency could not be chosen, so the caller can report it precisely. */
export type CurrencyResolution =
  | { readonly ok: true; readonly currency: Currency; readonly assumptions: string[] }
  | { readonly ok: false; readonly named: Currency[] }

/**
 * Decide the mandate's currency: what the user **wrote** first, then the catalog, then the default.
 *
 * The precedence, and the reason for each step:
 *
 * 1. **Text wins.** `"under 130 dollars"` in a USD account is a USD mandate *because the user wrote
 *    dollars*. If the store prices in INR, the Gate will block the checkout with `CS_CURRENCY_MISMATCH`
 *    and §12.13's copy tells them to create a mandate in the store currency. That is the correct
 *    outcome — it is the user's decision to make, and making it for them would be a silent FX
 *    conversion (EC-FX-1).
 * 2. **Two named currencies is a refusal.** A silent choice between them would invent a number.
 * 3. **A single-currency catalog is strong evidence.** If every SKU is priced in INR, assuming USD would
 *    produce a mandate that cannot possibly be spent. It becomes an *assumption* the read-back shows.
 * 4. **The account default is the last resort**, always as a stated assumption.
 */
export function resolveCurrency(args: {
  readonly text: string
  readonly defaultCurrency: Currency
  readonly catalogCurrencies: readonly Currency[]
}): CurrencyResolution {
  const named = currenciesNamedIn(args.text)
  if (named.length > 1) return { ok: false, named }
  if (named.length === 1) return { ok: true, currency: named[0]!, assumptions: [] }

  const catalog = [...new Set(args.catalogCurrencies)].filter(isCurrency)
  if (catalog.length === 1) {
    const only = catalog[0]!
    return {
      ok: true,
      currency: only,
      assumptions: [
        `Assumed ${only} because every item in the store you chose is priced in ${only}.`,
      ],
    }
  }
  return {
    ok: true,
    currency: args.defaultCurrency,
    assumptions: [
      catalog.length > 1
        ? `Assumed ${args.defaultCurrency} because you did not name a currency and the store lists items in ${joinWithAnd(catalog)}.`
        : `Assumed ${args.defaultCurrency} because you did not name a currency.`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Literal amounts
// ---------------------------------------------------------------------------

/** SI-style magnitude suffixes a person actually types: "max $1M", "under 5k". */
const MAGNITUDES: Readonly<Record<string, bigint>> = {
  k: 1_000n,
  m: 1_000_000n,
  b: 1_000_000_000n,
}

/** `130`, `1,000`, `129.99` → the digits, with separators removed. */
function normaliseDigits(raw: string): string {
  return raw.replace(/[,_]/g, '')
}

/**
 * An amount written as `<digits><magnitude>`, as integer minor units of `currency`.
 *
 * Returns `null` for anything `core.fromPayPalValue` refuses — most importantly a third decimal place,
 * which is `CS_ROUNDING` there and must stay a refusal here too (EC-FX-5). A literal the compiler
 * cannot read exactly is not a cap it should enforce against.
 */
function toMinor(
  rawDigits: string,
  magnitude: string | undefined,
  currency: Currency,
): bigint | null {
  let money: Money
  try {
    money = fromPayPalValue(normaliseDigits(rawDigits), currency)
  } catch {
    return null
  }
  return magnitude === undefined ? money.minor : money.minor * MAGNITUDES[magnitude]!
}

/**
 * `$130`, `US$1M`, `₹2,000`, `€12.50` — a symbol immediately before the number.
 *
 * The digit group's leading lookbehind rejects a preceding `-` or `.`, so a *negative* amount ("under -50")
 * is not read as a positive cap. `$` immediately before the digits is fine and still matches.
 */
const SYMBOL_AMOUNT_RE =
  /([A-Za-z]{0,2})\s?([$€£₹¥])\s*(?<![\d.-])(\d[\d,]*(?:\.\d+)?)\s*([kmb])?/giu

/**
 * `130 dollars`, `1M USD`, `200 rupees` — a currency word immediately after the number.
 *
 * Same leading lookbehind as {@link SYMBOL_AMOUNT_RE}, for the same reason.
 */
const NAMED_AMOUNT_RE =
  /(?<![\d.-])(\d[\d,]*(?:\.\d+)?)\s*([kmb])?\s*(usd|eur|gbp|inr|jpy|aud|cad|dollars?|euros?|pounds?|rupees?|yen)\b/giu

/** An ISO date, removed before the bare-number fallback so `2026-10-01` is not read as $20,260. */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g

/** A four-digit year, removed for the same reason. */
const YEAR_RE = /\b(?:19|20)\d{2}\b/g

/**
 * A bare number, not attached to a letter, a dot or a hyphen — so `SKU-TRAIL-42` and `ISO-4217` are not
 * amounts, and `-50` is not a cap.
 *
 * The trailing `([kmb])?` is inside the match, which is what lets "under 5k" read as five hundred thousand
 * minor units while still refusing a number glued to a word.
 */
const BARE_NUMBER_RE = /(?<![\w.-])(\d[\d,]*(?:\.\d+)?)\s*([kmb])?(?![\w.-])/gi

/**
 * The largest amount the user **literally typed**, in integer minor units, or `null` if there is none.
 *
 * Money-denominated amounts are preferred: if the text contains any (`$130`, `130 dollars`, `1M USD`),
 * only those count. Otherwise the fallback reads plain numbers with dates and years removed, because
 * "buy 2 pairs of shoes, cap 40" *should* bound the cap at $40 even though no currency is named.
 *
 * @param currency the mandate currency, so `"1M"` becomes 1,000,000 units of *that* currency rather
 *   than a number in an unknown one.
 */
export function literalCapIn(text: string, currency: Currency): bigint | null {
  let best: bigint | null = null
  const consider = (value: bigint | null): void => {
    if (value !== null && (best === null || value > best)) best = value
  }

  for (const m of text.matchAll(SYMBOL_AMOUNT_RE)) {
    consider(toMinor(m[3] ?? '0', m[4]?.toLowerCase(), currency))
  }
  for (const m of text.matchAll(NAMED_AMOUNT_RE)) {
    consider(toMinor(m[1] ?? '0', m[2]?.toLowerCase(), currency))
  }
  if (best !== null) return best

  const withoutDates = text.replace(ISO_DATE_RE, ' ').replace(YEAR_RE, ' ')
  for (const m of withoutDates.matchAll(BARE_NUMBER_RE)) {
    consider(toMinor(m[1] ?? '0', m[2]?.toLowerCase(), currency))
  }
  return best
}

/**
 * Whether the text justifies a **recurring** mandate.
 *
 * The same reasoning as {@link literalCapIn}, applied to the other axis of authority: a model that
 * turns "buy running shoes" into a twelve-month subscription has invented the single largest grant of
 * authority in the system, and no amount of numeric checking would catch it. A recurring constraint is
 * therefore only emitted when a recurrence word is actually present.
 */
const RECURRENCE_WORDS_RE =
  /\b(daily|day|weekly|week|fortnight|biweekly|monthly|month|quarterly|quarter|annual|annually|yearly|year|every|subscribe|subscription|recurring|recurrence|repeat|repeating|each\s+(day|week|month|quarter|year))\b/iu

export function mentionsRecurrence(text: string): boolean {
  return RECURRENCE_WORDS_RE.test(text)
}

/**
 * Does the text support **this particular** frequency?
 *
 * `mentionsRecurrence` answers "may there be a recurrence at all", and that is the only question it
 * can answer — it is a boolean over any recurrence word. Which means a proposal of `WEEK` for
 * *"$40 a month"* passes it, because the text does mention a recurrence word. The mandate then
 * authorises four times the spend the buyer wrote, and every green check afterwards is about a
 * different number.
 *
 * Found in the live eval: the compiler refused `"subscribe to a coffee delivery for $40 a month"`
 * for an unrelated reason (a start date in the past), and fixing that refusal exposed the frequency
 * — a *worse* failure than the one it replaced, because a refusal is safe and a wrong frequency is
 * not.
 *
 * **Conservative by construction.** An unknown frequency, or one with no word support, returns
 * `false`; the caller refuses rather than signing a cadence the buyer did not write. That is the
 * opposite direction from a clamp, and deliberately: clamping a *cap* reduces authority, whereas
 * accepting a *frequency* the buyer did not write increases it.
 *
 * `TWMN`, `TOMN`, `FOMN` and `TYEA` are the "every N" cadences. They are matched by their explicit
 * forms only (`every two months`), never by the bare noun, because "every two months" is a different
 * authority from "monthly" and the whole point of this function is not to conflate them.
 */
const FREQUENCY_WORDS: Readonly<Record<string, readonly RegExp[]>> = {
  INDA: [/\beach\s+time\b/iu, /\bper\s+purchase\b/iu, /\bevery\s+purchase\b/iu],
  DAIL: [/\bdaily\b/iu, /\bevery\s+day\b/iu, /\ba\s+day\b/iu, /\bper\s+day\b/iu],
  WEEK: [/\bweekly\b/iu, /\bevery\s+week\b/iu, /\ba\s+week\b/iu, /\bper\s+week\b/iu],
  TWOK: [/\bfortnight/iu, /\bbi-?weekly\b/iu, /\bevery\s+(two|2)\s+weeks?\b/iu],
  TWMN: [/\bevery\s+(two|2)\s+months?\b/iu, /\bbi-?monthly\b/iu],
  MNTH: [/\bmonthly\b/iu, /\bevery\s+month\b/iu, /\ba\s+month\b/iu, /\bper\s+month\b/iu],
  TOMN: [/\bevery\s+(three|3)\s+months?\b/iu, /\bquarterly\b/iu],
  QUTR: [/\bquarterly\b/iu, /\bevery\s+quarter\b/iu, /\ba\s+quarter\b/iu, /\bper\s+quarter\b/iu],
  FOMN: [/\bevery\s+(four|4)\s+months?\b/iu],
  SEMI: [/\bsemi-?annual/iu, /\bhalf-?yearly\b/iu, /\bevery\s+six\s+months\b/iu],
  YEAR: [/\byearly\b/iu, /\bannually\b/iu, /\bannual\b/iu, /\bevery\s+year\b/iu, /\ba\s+year\b/iu],
  TYEA: [/\bevery\s+(two|2)\s+years?\b/iu, /\bbi-?annual\b/iu],
}

export function frequencyInText(text: string, frequency: string): boolean {
  const patterns = FREQUENCY_WORDS[frequency]
  // Unknown cadence ⇒ not supported. A `true` here would be this function claiming a buyer wrote
  // something it cannot read.
  if (patterns === undefined) return false
  return patterns.some((re) => re.test(text))
}
