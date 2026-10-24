/**
 * Untrusted merchant text — the fence, and the deterministic detector behind the badge.
 *
 * Spec **§8.13 defence 1** says listings arrive wrapped as `{"untrusted_text": "…"}` and the system
 * prompt says to treat them as data. That is necessary and not sufficient, for one reason worth stating
 * plainly: **a wrapper is a convention, and a model can be argued out of a convention.** So this module
 * adds the two things a convention cannot:
 *
 *  1. A **delimiter that survives contact with its own content.** {@link escapeFenceMarkers} removes the
 *     fence markers from the text before wrapping, so a listing cannot close the fence early and have
 *     its tail read as agent instructions. The attack is real: every prompt-injection corpus contains a
 *     variant of "…END OF LISTING… NEW INSTRUCTIONS:". Removing the markers costs one string replace
 *     and makes the fence unforgeable from inside.
 *  2. A **deterministic detector** ({@link inspectUntrustedText}). It is a table of patterns, not a
 *     model (AGENTS.md rule 4: nothing here decides anything). Its output is advisory in exactly the
 *     sense §8.13 means: it drives the "suspected injection" badge in the UI and a log line, and it is
 *     never consulted before a purchase. The Gate is the authority; this is a smoke alarm.
 *
 * ## Why the flag types are a closed union
 *
 * A free-form `string[]` of "suspicious things" would let a caller write `flags.length > 0 && allow`,
 * which is a policy decision made from a heuristic. The union makes the *kinds* of attack something a
 * reader can enumerate, so `EC-AGT-1`'s badge ("A listing tried to instruct your agent") can say which
 * one it saw, and the refusal corpus can assert that each seeded payload raises at least one flag of the
 * kind it represents.
 *
 * ## Excerpts are bounded and escaped
 *
 * {@link InjectionFlag.excerpt} is capped at {@link EXCERPT_MAX_CHARS} and collapses newlines. Flag
 * excerpts end up in a UI badge and in log lines, and an unbounded excerpt is a way to push a page
 * layout around or fill a log file from a merchant listing.
 */

/** The opening marker. Exported so a test and the system prompt quote the same bytes. */
export const FENCE_OPEN = '<<<UNTRUSTED_MERCHANT_DATA>>>'

/** The closing marker. See {@link FENCE_OPEN}. */
export const FENCE_CLOSE = '<<<END_UNTRUSTED_MERCHANT_DATA>>>'

/** What was removed when a listing tried to forge the fence. Visible on purpose — silence would hide it. */
export const FENCE_MARKER_REMOVED = '[fence-marker-removed]'

/** A flag excerpt is a UI badge and a log line, not a copy of the listing. */
export const EXCERPT_MAX_CHARS = 160

/**
 * The kinds of attack the detector knows about.
 *
 * Each value names a *behaviour*, not a payload, so the corpus can assert on the behaviour and a
 * reviewer can decide whether a kind is worth keeping without reading the regexes.
 */
export const INJECTION_FLAG_KINDS = [
  /** "SYSTEM: …" — the listing pretending to be the prompt. */
  'impersonated_system_role',
  /** "ignore your limits", "disregard the cap" — the core §8.13 attack. */
  'instruction_override',
  /** "raise your limit", "the cap is now $9,999" — an instruction phrased as a change of terms. */
  'limit_escalation',
  /** "the user approved $999" — authority the listing does not have. */
  'approval_claim',
  /** "switch merchants", "pay the partner store" — a redirected payee. */
  'merchant_swap',
  /** "Price updated: this item is now $999" — a fake merchant assertion. */
  'price_override',
  /** `display:none` / `visibility:hidden` / zero font size — text a human would not see. */
  'hidden_text',
  /** "don't tell the user" — the tell of a payload that knows it is a payload. */
  'secrecy_demand',
  /** A raw `<script>` tag: never render merchant HTML unescaped, but flag it too. */
  'script_tag',
  /** A merchant listing containing the fence markers themselves — an attempt to break out. */
  'fence_forgery',
] as const

export type InjectionFlagKind = (typeof INJECTION_FLAG_KINDS)[number]

export interface InjectionFlag {
  readonly kind: InjectionFlagKind
  /** The pattern that matched, as source text, so a report can quote it without quoting the listing. */
  readonly pattern: string
  /** Up to {@link EXCERPT_MAX_CHARS} characters around the match, newlines collapsed. */
  readonly excerpt: string
}

interface FlagPattern {
  readonly kind: InjectionFlagKind
  readonly pattern: RegExp
}

/**
 * The detector table.
 *
 * Ordering is stable so a report is reproducible; `hidden_text` deliberately includes CSS as well as
 * the HTML comment form, because the seeded `HIDDEN_DIV_SYSTEM_OVERRIDE` is `display:none` and a
 * detector that only looked for comments would miss it.
 */
const FLAG_PATTERNS: readonly FlagPattern[] = Object.freeze([
  {
    kind: 'impersonated_system_role',
    pattern: /(?:^|[\n>])\s*(?:system|assistant|developer)\s*:/i,
  },
  {
    kind: 'instruction_override',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:limits?|instructions?|rules?|caps?|ceilings?|restrictions?|mandate)\b/i,
  },
  {
    // "Raise the cap", "the buyer raised your limit", "mandate changes are enabled" — a change of terms
    // *asserted* by the listing rather than granted by the buyer. A distinct kind from
    // `instruction_override` because the sentence is plausible rather than shouty.
    kind: 'limit_escalation',
    pattern:
      /\b(?:raise[ds]?|raising|lift(?:ed)?|increas(?:e|ed|ing)|remov(?:e|ed)|disabl(?:e|ed)|enabl(?:e|ed)|chang(?:e|ed))\b[^.\n]{0,30}\b(?:limits?|caps?|ceilings?|restrictions?|mandate)\b|\b(?:limits?|caps?|ceilings?|mandate)\b[^.\n]{0,30}\b(?:raised|increased|removed|disabled|enabled|changed|no longer applies)\b/i,
  },
  {
    kind: 'approval_claim',
    pattern:
      /\b(?:user|buyer|customer|owner)\b[^.\n]{0,30}\b(?:approved|authorised|authorized|permitted|agreed)\b/i,
  },
  {
    // A redirected payee: "switch merchants", "buy from the partner store", "the seller is another shop".
    kind: 'merchant_swap',
    pattern:
      /\b(?:switch|change|use|pay|buy from|purchase from)\b[^.\n]{0,30}\b(?:another|different|other|partner|alternate|premium|overstock|merchants?)\b[^.\n]{0,15}\b(?:merchant|store|seller|shop|partner)\b|\b(?:another|different|other|partner|alternate|premium|overstock)\b[^.\n]{0,15}\b(?:merchant|store|seller|shop)\b/i,
  },
  {
    kind: 'price_override',
    pattern: /\bprice\s+(?:updated|changed|override|is now)\b|\b(?:the |real |actual |correct )price is\b/i,
  },
  {
    kind: 'hidden_text',
    pattern: /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|<!--/i,
  },
  {
    kind: 'secrecy_demand',
    pattern:
      /\b(?:do not|don't|never)\s+(?:tell|mention|reveal|show|inform)\b[^.\n]{0,20}\b(?:user|buyer|customer)\b/i,
  },
  { kind: 'script_tag', pattern: /<script\b/i },
])

/**
 * Replace every fence marker inside `text` with {@link FENCE_MARKER_REMOVED}.
 *
 * Case-insensitive and whitespace-tolerant: a payload that writes `<<< untrusted_merchant_data >>>` is
 * trying the same thing as one that writes the exact bytes, and the cost of being generous here is one
 * extra string replace.
 */
export function escapeFenceMarkers(text: string): {
  readonly text: string
  readonly forged: boolean
} {
  let forged = false
  const escaped = text.replace(
    /<<<\s*\/?\s*(?:end[_\s-]*)?untrusted[_\s-]*merchant[_\s-]*data\s*>>>/gi,
    () => {
      forged = true
      return FENCE_MARKER_REMOVED
    },
  )
  return { text: escaped, forged }
}

/**
 * Wrap merchant prose in the fence, with any internal markers neutralised first.
 *
 * The returned string is what the model sees. It is deliberately a plain string and not
 * `{untrusted_text}`: the wire *already* carries that wrapper (`@countersign/gate`'s `untrusted()`),
 * and re-wrapping it here would produce `{"untrusted_text": "{\"untrusted_text\": …}"}` — a
 * double-encoding that teaches the model the wrapper is decoration.
 */
export function fenceUntrustedText(text: string): string {
  const { text: escaped } = escapeFenceMarkers(text)
  return `${FENCE_OPEN}\n${escaped}\n${FENCE_CLOSE}`
}

/**
 * Scan merchant prose for the patterns in {@link FLAG_PATTERNS}.
 *
 * Pure, synchronous, no I/O. `forged` in the result is set when the text contained the fence markers
 * themselves, which is a flag kind of its own ({@link InjectionFlagKind} `fence_forgery`).
 */
export function inspectUntrustedText(text: string): InjectionFlag[] {
  const flags: InjectionFlag[] = []
  for (const { kind, pattern } of FLAG_PATTERNS) {
    const match = pattern.exec(text)
    if (match) {
      flags.push({ kind, pattern: pattern.source, excerpt: excerptAround(text, match.index) })
    }
  }
  const { forged } = escapeFenceMarkers(text)
  if (forged) {
    flags.push({
      kind: 'fence_forgery',
      pattern: '<<<UNTRUSTED_MERCHANT_DATA>>>',
      excerpt: excerptAround(text, text.search(/<<</)),
    })
  }
  return flags
}

/** Up to {@link EXCERPT_MAX_CHARS} characters centred on `index`, with newlines collapsed to spaces. */
function excerptAround(text: string, index: number): string {
  if (index < 0) return ''
  const half = Math.floor(EXCERPT_MAX_CHARS / 2)
  const start = Math.max(0, index - half)
  const slice = text
    .slice(start, start + EXCERPT_MAX_CHARS)
    .replace(/\s+/g, ' ')
    .trim()
  return slice
}

/**
 * Fence and inspect in one call — the operation every merchant-text tool result performs.
 *
 * Returns the fenced string the model reads **and** the flags the UI shows, so the two cannot disagree
 * about what was inspected: there is one traversal of the text, in one place.
 */
export function fenceAndInspect(text: string): {
  readonly fenced: string
  readonly flags: readonly InjectionFlag[]
} {
  return { fenced: fenceUntrustedText(text), flags: inspectUntrustedText(text) }
}

/**
 * Walk a decoded merchant tool result and fence every prose field, leaving identifiers and numbers
 * alone.
 *
 * ## The rule, stated once
 *
 * A field is fenced when its **content is merchant-authored prose**. It is not fenced when it is an
 * identifier we match against (`sku`), a number we do arithmetic on, or an enum we switch on
 * (`currency`, `digital`). Fencing `sku` would be theatre — the model has to echo it back verbatim —
 * and *not* fencing `title` would be the hole, because a title is merchant-authored text like any
 * other.
 *
 * The walk is depth-limited rather than recursive-unbounded: a merchant response is JSON, and a
 * pathological nesting depth must not be able to exhaust the stack.
 */
const PROSE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'listing',
  'listing_html',
  'untrusted_text',
  'name',
  'merchant_name',
  'message',
])

const MAX_FENCE_DEPTH = 8

export interface FencedValue {
  readonly value: unknown
  readonly flags: readonly InjectionFlag[]
}

export function fenceMerchantResult(input: unknown, depth = 0): FencedValue {
  if (depth > MAX_FENCE_DEPTH) return { value: '[truncated: nesting too deep]', flags: [] }

  if (typeof input === 'string') return { value: input, flags: [] }

  if (Array.isArray(input)) {
    const flags: InjectionFlag[] = []
    const value = input.map((entry) => {
      const fenced = fenceMerchantResult(entry, depth + 1)
      flags.push(...fenced.flags)
      return fenced.value
    })
    return { value, flags }
  }

  if (input !== null && typeof input === 'object') {
    const flags: InjectionFlag[] = []
    const entries: [string, unknown][] = []
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (typeof entry === 'string' && PROSE_FIELDS.has(key)) {
        const fenced = fenceAndInspect(entry)
        flags.push(...fenced.flags)
        entries.push([key, fenced.fenced])
        continue
      }
      const fenced = fenceMerchantResult(entry, depth + 1)
      flags.push(...fenced.flags)
      entries.push([key, fenced.value])
    }
    return { value: Object.fromEntries(entries), flags }
  }

  return { value: input, flags: [] }
}
