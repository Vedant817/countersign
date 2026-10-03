/**
 * Money — spec §8.1 M1, §0 ("Money is always integer minor units plus an ISO-4217 currency code.
 * Floats are never used.").
 *
 * The single most important rule in this file: **no float ever touches a money value.** Amounts
 * arrive from three untrusted places (an LLM, PayPal JSON, a human typing in a form) and all three
 * are converted through {@link fromPayPalValue}, which parses decimal *strings* with `bigint`
 * arithmetic. `129.99` from a model becomes `12999n` or a validation error — never `129.98999999999998`.
 */

import { csError, type CsError, type CsErrorCode } from './errors'

/** Currencies the demo supports. Displaying others is a P2 item (spec §2). */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD'] as const
export type Currency = (typeof CURRENCIES)[number]

/** Number of minor-unit digits per currency. JPY has none; everything we support has two. */
export const MINOR_DIGITS: Record<Currency, 0 | 2> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  INR: 2,
  JPY: 0,
  AUD: 2,
  CAD: 2,
}

/** A currency-aware integer amount. `minor` is in the currency's minor unit (cents, yen). */
export interface Money {
  readonly minor: bigint
  readonly currency: Currency
}

/** ISO-4217 alphabetic code, upper case. */
const CURRENCY_RE = /^[A-Z]{3}$/

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

/**
 * Coerce to `Currency` or throw `CS_VALIDATION`.
 * Used at boundaries (env parsing, JSON bodies) so the rest of the code can trust the type.
 */
export function currency(value: unknown): Currency {
  if (typeof value !== 'string' || !CURRENCY_RE.test(value) || !isCurrency(value)) {
    throw csError('CS_VALIDATION', `Unsupported currency: ${JSON.stringify(value)}`, {
      supported: CURRENCIES,
    })
  }
  return value
}

export function money(minor: bigint | number | string, cur: Currency): Money {
  const m = typeof minor === 'bigint' ? minor : BigInt(minor)
  if (m < 0n) {
    throw csError('CS_VALIDATION', 'Money cannot be negative in a Money value', { minor: String(m) })
  }
  return { minor: m, currency: cur }
}

export function isMoney(value: unknown): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    'minor' in value &&
    'currency' in value &&
    typeof (value as { minor: unknown }).minor === 'bigint' &&
    isCurrency((value as { currency: unknown }).currency)
  )
}

function mismatch(a: Currency, b: Currency): CsError {
  return csError('CS_CURRENCY_MISMATCH', `Currency mismatch: ${a} vs ${b}`, { a, b })
}

/** Add. Same currency or `CS_CURRENCY_MISMATCH`. We never convert. */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw mismatch(a.currency, b.currency)
  return { minor: a.minor + b.minor, currency: a.currency }
}

export function sub(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw mismatch(a.currency, b.currency)
  const r = a.minor - b.minor
  if (r < 0n) {
    throw csError('CS_VALIDATION', 'sub would produce a negative amount', {
      a: String(a.minor),
      b: String(b.minor),
    })
  }
  return { minor: r, currency: a.currency }
}

/**
 * Sum a list of amounts. Empty is `0` in `cur`. Used by the budget ledger's invariant check.
 */
export function sum(items: readonly Money[], cur: Currency): Money {
  let total = 0n
  for (const m of items) {
    if (m.currency !== cur) throw mismatch(m.currency, cur)
    total += m.minor
  }
  return { minor: total, currency: cur }
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) throw mismatch(a.currency, b.currency)
  if (a.minor < b.minor) return -1
  if (a.minor > b.minor) return 1
  return 0
}

export function isZero(a: Money): boolean {
  return a.minor === 0n
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b
}

/**
 * A finite upper bound check that returns a reason instead of throwing.
 * The Gate needs "and *why*", so it uses this rather than comparing bigints inline.
 */
export function exceedsCap(a: Money, cap: Money): { ok: true } | { ok: false; over: Money; code: CsErrorCode } {
  if (a.currency !== cap.currency) {
    return { ok: false, over: a, code: 'CS_CURRENCY_MISMATCH' }
  }
  if (a.minor > cap.minor) {
    return { ok: false, over: { minor: a.minor - cap.minor, currency: a.currency }, code: 'GATE_BUDGET_EXCEEDED' }
  }
  return { ok: true }
}

/** Exact decimal string, no exponent, no trailing zeros beyond the currency's digits. */
const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/

/**
 * Parse a PayPal decimal string into integer minor units.
 *
 * Rejects, with a typed error:
 *  - anything with more decimal places than the currency has minor digits → `CS_ROUNDING`
 *    (e.g. `"1.005"` USD, spec §8.1 AT-M1.2). Silently rounding here is how money bugs start.
 *  - exponent or leading-plus forms (`"1e3"`, `"+1.00"`) → `CS_VALIDATION`
 *  - negative values → `CS_VALIDATION`
 *  - empty / non-numeric → `CS_VALIDATION`
 */
export function fromPayPalValue(value: string, cur: Currency): Money {
  const digits = MINOR_DIGITS[cur]
  if (typeof value !== 'string') {
    throw csError('CS_VALIDATION', 'Money value must be a string', { received: typeof value })
  }
  const v = value.trim()
  if (v === '') {
    throw csError('CS_VALIDATION', 'Money value is empty')
  }
  if (v.startsWith('-')) {
    throw csError('CS_VALIDATION', 'Money value is negative', { value: v })
  }
  if (/[eE]/.test(v) || v.startsWith('+') || /[_\s]/.test(v)) {
    throw csError('CS_VALIDATION', 'Money value has an unsupported numeric form', { value: v })
  }
  if (!DECIMAL_RE.test(v)) {
    throw csError('CS_VALIDATION', 'Money value is not a plain decimal', { value: v })
  }
  const [intPart = '0', fracPart = ''] = v.split('.')
  if (fracPart.length > digits) {
    throw csError(
      'CS_ROUNDING',
      `${cur} has ${digits} minor digits; "${v}" has ${fracPart.length}. Refusing to round.`,
      { value: v, currency: cur, minorDigits: digits, decimals: fracPart.length },
    )
  }
  const padded = fracPart.padEnd(digits, '0')
  const minor = BigInt(intPart) * 10n ** BigInt(digits) + (padded === '' ? 0n : BigInt(padded))
  return { minor, currency: cur }
}

/**
 * Render integer minor units as the exact decimal string PayPal expects.
 *
 * `12345n USD -> "123.45"`, `500n JPY -> "500"`. Always two (or zero) decimals, so the string
 * round-trips through {@link fromPayPalValue} unchanged.
 */
export function toPayPalValue(m: Money): string {
  const digits = MINOR_DIGITS[m.currency]
  if (digits === 0) return m.minor.toString()
  const s = m.minor.toString().padStart(digits + 1, '0')
  const intPart = s.slice(0, -digits)
  const fracPart = s.slice(-digits)
  return `${intPart}.${fracPart}`
}

/** Display string for the UI: `"$130.00"`, `"₹1,299.00"`, `"¥500"`. */
const SYMBOL: Record<Currency, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
  AUD: 'A$',
  CAD: 'C$',
}

export function formatMoney(m: Money, opts: { symbol?: boolean; grouping?: boolean } = {}): string {
  const { symbol = true, grouping = true } = opts
  const digits = MINOR_DIGITS[m.currency]
  const neg = m.minor < 0n
  const abs = neg ? -m.minor : m.minor
  const s = abs.toString().padStart(digits + 1, '0')
  const intPart = digits === 0 ? s : s.slice(0, -digits)
  const fracPart = digits === 0 ? '' : s.slice(-digits)
  const grouped = grouping ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart
  const body = fracPart === '' ? grouped : `${grouped}.${fracPart}`
  return `${neg ? '-' : ''}${symbol ? SYMBOL[m.currency] : ''}${body}`
}

/** "USD 123.45" — the form used in evidence packets and logs, where a symbol alone is ambiguous. */
export function formatMoneyCode(m: Money): string {
  return `${m.currency} ${toPayPalValue(m)}`
}

/**
 * Largest-remainder allocation of `total` across `weights`.
 *
 * This is the spec's answer to "split a total across shipments without losing a cent"
 * (EC-FX-4, EC-REF-5). The naive `floor(total * w / sum)` loses or invents minor units; largest
 * remainder hands the leftover cents to the largest fractional parts, so:
 *
 *   - the parts are non-negative and integers,
 *   - `sum(parts) === total` exactly, always,
 *   - and every part differs from the naive share by less than one minor unit.
 *
 * @param weights relative sizes; all non-negative, not all zero.
 * @returns `weights.length` amounts summing exactly to `total`, in the same order.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw csError('CS_VALIDATION', 'allocate needs at least one weight')
  }
  for (const w of weights) {
    if (w < 0n) throw csError('CS_VALIDATION', 'allocate weights must be non-negative', { weight: String(w) })
  }
  const sumWeights = weights.reduce((a, b) => a + b, 0n)
  if (sumWeights === 0n) {
    throw csError('CS_VALIDATION', 'allocate weights sum to zero')
  }
  if (total.minor < 0n) {
    throw csError('CS_VALIDATION', 'allocate total is negative')
  }

  const n = BigInt(weights.length)
  // floor(total * w / W) with bigint math, and the remainder for the ranking.
  const exactNumerator = (i: number) => total.minor * weights[i]!
  const base = weights.map((w) => (total.minor * w) / sumWeights)
  let remainderSum = total.minor - base.reduce((a, b) => a + b, 0n)

  // Rank by remainder descending; ties break by original index so the result is deterministic.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = exactNumerator(a) % sumWeights
      const rb = exactNumerator(b) % sumWeights
      if (ra !== rb) return ra > rb ? -1 : 1
      return a - b
    })

  const out = base.slice()
  let left = remainderSum
  for (const i of order) {
    if (left <= 0n) break
    out[i] = out[i]! + 1n
    left -= 1n
  }
  remainderSum = left
  if (remainderSum !== 0n) {
    // Unreachable: remainderSum < weights.length by construction. Kept as a loud invariant.
    throw csError('CS_ROUNDING', 'largest-remainder allocation did not close', {
      left: String(remainderSum),
      parts: BigInt(n).toString(),
    })
  }

  const parts = out.map((minor) => ({ minor, currency: total.currency }))
  // Belt and braces: the caller must never receive money that does not add up.
  const check = parts.reduce((a, b) => a + b.minor, 0n)
  if (check !== total.minor) {
    throw csError('CS_ROUNDING', 'allocation does not sum to the total', {
      total: String(total.minor),
      sum: String(check),
    })
  }
  return parts
}

/**
 * Split `total` into `weights`-proportional parts where the **last** part absorbs every rounding
 * cent, so the final figure is always exactly `total − everything before it`.
 *
 * The difference from {@link allocate} is who gets the leftover minor units. Largest-remainder hands
 * them to the largest fractional share; this hands *all* of them to the last part. The defender uses
 * this for "refunded $12.34 of $20.00" lines, where the remainder has to be a single number a
 * human can check, not a distribution across several rows.
 *
 * @example allocateWithRemainderLast(1000n USD, [1n,1n,1n]) // [333, 333, 334]
 */
export function allocateWithRemainderLast(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw csError('CS_VALIDATION', 'allocateWithRemainderLast needs at least one weight')
  }
  for (const w of weights) {
    if (w < 0n) throw csError('CS_VALIDATION', 'allocate weights must be non-negative', { weight: String(w) })
  }
  const W = weights.reduce((a, b) => a + b, 0n)
  if (W === 0n) {
    throw csError('CS_VALIDATION', 'allocate weights sum to zero')
  }
  if (weights.length === 1) return [{ minor: total.minor, currency: total.currency }]

  // Each of the first n-1 parts takes the *floor* of its exact share of the whole total. That means
  // sum(head) <= total always, so the last part is non-negative.
  const head = weights.slice(0, -1).map((w) => (total.minor * w) / W)
  const allocated = head.reduce((a, b) => a + b, 0n)
  const parts = head.map((minor) => ({ minor, currency: total.currency }))
  parts.push({ minor: total.minor - allocated, currency: total.currency })
  return parts
}

/** Ratio check: does `amount` fall inside `[min, max]`? Used by the Gate's amount-range check. */
export function withinRange(amount: Money, range: { currency: Currency; min?: number; max?: number }):
  | { ok: true }
  | { ok: false; reason: 'CURRENCY' | 'BELOW_MIN' | 'ABOVE_MAX' } {
  if (amount.currency !== range.currency) return { ok: false, reason: 'CURRENCY' }
  if (range.min !== undefined && amount.minor < BigInt(range.min)) return { ok: false, reason: 'BELOW_MIN' }
  if (range.max !== undefined && amount.minor > BigInt(range.max)) return { ok: false, reason: 'ABOVE_MAX' }
  return { ok: true }
}

/**
 * Parse a money input from a human or an LLM.
 *
 * Accepts `"$130.00"`, `"130"`, `"130.5"`, `130.5n`? No — **never** a JS number, because
 * `parseFloat("130.10")` already threw away a cent. Callers pass strings.
 *
 * A bare number is rejected on purpose: if a float reached this function the precision is
 * already gone and the only honest response is to refuse.
 */
export function parseMoneyInput(raw: string, cur: Currency): Money {
  const cleaned = raw.trim().replace(/^[^\d.-]+/, '').replace(/,/g, '')
  return fromPayPalValue(cleaned, cur)
}