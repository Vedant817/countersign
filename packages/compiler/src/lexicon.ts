/**
 * The catalog **lexicon** — the words the store itself uses, turned into something a deterministic
 * reader can match, and nothing else. Spec §8.8 (M8), WP-08 / P0-7.
 *
 * ## Why this exists at all
 *
 * The compiler used to learn which store and which product a buyer meant from the model. That made the
 * model a *source* of the mandate's scope: a sentence naming no store could come back constrained to one
 * anyway. The lexicon inverts that. It is built from the same `CatalogProjection` the prompt is built
 * from, so every merchant and item the reader can name is an item the store actually sells — and the
 * reader is a pure function of `(text, catalog)`, which is what makes it testable and reproducible.
 *
 * ## How matching works, and why it is token-based
 *
 * Both sides are reduced to **normalised token sequences**: lowercase, split on non-alphanumerics, and a
 * trailing `s` stripped unless the word ends in `ss` (`"shoes"` → `shoe`, `"glass"` → `glass`). A phrase
 * matches when its tokens appear as a contiguous run in the text's tokens.
 *
 * A token-based match rather than a substring search is what stops `"NW-021"` from matching inside
 * `"NW-0210"`, and it makes plural tolerance fall out of the normalisation instead of a pile of `s?`
 * patterns. It also means `"Trail Runner"` matches `"trail runners"` — the buyer writes plurals.
 *
 * ## What is deliberately *not* here
 *
 * No synonyms, no embeddings, no category table authored by hand. `"waterproof jacket"` does not become
 * `Alpine Hard Shell Jacket` here; the word `jacket` matches every jacket in the catalog and nothing
 * more. Semantic search is the agent's job (§8.13), and a compiler that guessed at synonyms would be
 * inventing a scope the buyer did not write. {@link LexiconEntry.alias} matching is exact-or-nothing.
 */
import type { CatalogMerchant, CatalogProjection, CatalogSku } from './types'

/** One thing the catalog can be matched by: its id, and every normalised phrase that names it. */
export interface LexiconEntry {
  readonly id: string
  /** Normalised token phrases, longest first. Used for evidence and for longest-match preference. */
  readonly aliases: readonly string[]
  /** The catalog's own display name or title, kept for read-back and debugging. */
  readonly display: string
  /** For SKUs: the merchant that sells it, so an item cannot be matched without its store. */
  readonly merchantId?: string
}

export interface CatalogLexicon {
  readonly merchants: readonly LexiconEntry[]
  readonly skus: readonly LexiconEntry[]
  /**
   * Attribute values the catalog itself uses, so `"Slate"` or `"size M"` is a fact and not a guess.
   * `raw` is the catalog's own spelling (what the read-back shows); `normalised` is what matching uses.
   */
  readonly attributes: Readonly<{
    colour: readonly { readonly raw: string; readonly normalised: string }[]
    size: readonly { readonly raw: string; readonly normalised: string }[]
    model: readonly { readonly raw: string; readonly normalised: string }[]
  }>
}

/**
 * Words that name no particular product and would otherwise match half the catalog (`"pack"`, `"2-pack"`,
 * `"1 L"`). Kept short and lowercase: it is a list of *measurement* words, not a stopword list for prose.
 */
const MEASURE_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'with',
  'for',
  'from',
  'pack',
  'set',
  'bundle',
  'digital',
  'ml',
  'kg',
  'cm',
  'mm',
  'lm',
])

/** Lowercase, split on non-alphanumerics, singularise a trailing `s` (never `ss`). */
export function normaliseTokens(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw === '') continue
    out.push(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }
  return out
}

/** A normalised phrase as a single string, for stable comparison and evidence. */
export function normalisePhrase(text: string): string {
  return normaliseTokens(text).join(' ')
}

/**
 * Every alias a product can be matched by.
 *
 * The **SKU id first** (`"NW-006"` is how the catalogue, the read-back and a test all name an item), then
 * the **full title**, then its individual words. Individual words are only kept when they are at least
 * four characters and are not a measurement word, because `"45"`, `"L"` and `"pack"` name nothing. A word
 * shared by two products (`"trail"`, `"sock"`) matches both — that is the honest reading of an ambiguous
 * word, and it is strictly narrower than the alternative of matching nothing.
 */
function skuAliases(sku: CatalogSku): string[] {
  const aliases: string[] = []
  const id = normalisePhrase(sku.id)
  if (id !== '') aliases.push(id)
  const full = normalisePhrase(sku.title)
  if (full !== '' && full !== id) aliases.push(full)
  for (const token of new Set(normaliseTokens(sku.title))) {
    if (token.length < 4 || MEASURE_WORDS.has(token) || /^\d/iu.test(token)) continue
    if (!aliases.includes(token)) aliases.push(token)
  }
  return aliases
}

/**
 * Every alias a merchant can be matched by.
 *
 * The full name, plus its first word when that word is long enough to be distinctive. `"Northwind
 * Outfitters"` is matched by `"northwind outfitters"` and by `"northwind"`; `"Home"` alone (from
 * `"Fabrikam Home"`) is not an alias of anything, which is the point of taking only the *first* word.
 */
function merchantAliases(merchant: CatalogMerchant): string[] {
  const aliases: string[] = []
  const full = normalisePhrase(merchant.name)
  if (full !== '') aliases.push(full)
  const first = normaliseTokens(merchant.name)[0]
  if (first !== undefined && first.length >= 4 && !aliases.includes(first)) aliases.push(first)
  return aliases
}

/** Build the lexicon for one catalog projection. Pure; call it once per read. */
export function buildLexicon(catalog: CatalogProjection): CatalogLexicon {
  const colour = new Map<string, string>()
  const size = new Map<string, string>()
  const model = new Map<string, string>()
  const remember = (into: Map<string, string>, raw: string): void => {
    const normalised = normalisePhrase(raw)
    if (normalised !== '' && !into.has(normalised)) into.set(normalised, raw)
  }
  for (const sku of catalog.skus) {
    const attrs = sku.attributes
    if (attrs?.colour !== undefined) remember(colour, attrs.colour)
    if (attrs?.size !== undefined) remember(size, attrs.size)
    if (attrs?.model !== undefined) remember(model, attrs.model)
  }
  const asList = (m: Map<string, string>): { raw: string; normalised: string }[] =>
    [...m.entries()]
      .map(([normalised, raw]) => ({ raw, normalised }))
      .sort((a, b) => (a.normalised < b.normalised ? -1 : 1))
  return {
    merchants: catalog.merchants.map((m) => ({
      id: m.id,
      aliases: merchantAliases(m),
      display: m.name,
    })),
    skus: catalog.skus.map((s) => ({
      id: s.id,
      aliases: skuAliases(s),
      display: s.title,
      merchantId: s.merchantId,
    })),
    attributes: {
      colour: asList(colour),
      size: asList(size),
      model: asList(model),
    },
  }
}

/** Whether `phrase` (normalised tokens) occurs as a contiguous run in `tokens`. */
function containsPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  return indexOfRun(tokens, phrase) !== -1
}

/** First token index at which `needle` occurs contiguously in `haystack`, or `-1`. */
export function indexOfRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let hit = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        hit = false
        break
      }
    }
    if (hit) return start
  }
  return -1
}

/**
 * The earliest token index at which any alias of `entry` appears, or `-1`.
 *
 * Used to find what the buyer wrote immediately before the item — the quantity (`"Two Trail Runners"`).
 * The *earliest* match is the one a person would point at, and using it rather than the first alias in
 * the list keeps the answer independent of alias ordering.
 */
export function firstAliasIndex(text: string, entry: LexiconEntry): number {
  const tokens = normaliseTokens(text)
  let best = -1
  for (const alias of entry.aliases) {
    const at = indexOfRun(tokens, alias.split(' '))
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  return best
}

/**
 * Match every entry whose aliases occur in the text, in catalog order.
 *
 * Catalog order, not match order, so the output is a pure function of the catalog and the text — the same
 * property the rest of the compiler keeps. An entry matches once however many times it is named.
 */
function matchAll(text: string, entries: readonly LexiconEntry[]): LexiconEntry[] {
  const tokens = normaliseTokens(text)
  return entries.filter((entry) =>
    entry.aliases.some((alias) => containsPhrase(tokens, alias.split(' '))),
  )
}

export function matchMerchants(text: string, lexicon: CatalogLexicon): LexiconEntry[] {
  return matchAll(text, lexicon.merchants)
}

/**
 * Match every SKU the text names, by the **longest** alias that fits, without overlaps.
 *
 * ## Why longest-match wins, and why overlaps are suppressed
 *
 * "Buy the Alpine Hard Shell Jacket under $200" contains the word *alpine* (also an alias of `Alpine Down
 * Vest`) and the word *jacket* (also `Tokyo Trail Jacket`). Matching each word independently returns three
 * items for a sentence that names one, and the mandate then permits two products the buyer never
 * mentioned. The buyer wrote the *full name* of a product, so the words inside that name belong to it:
 * the longest alias is matched first, its span is claimed, and an alias that falls inside a claimed span
 * is part of a name rather than a reference of its own.
 *
 * A word that no longer alias covers is still matched on its own (`"socks"` → both sock products), which
 * is the honest reading of an ambiguous word and is why the rule is "longest wins", not "only full names".
 */
export function matchSkus(text: string, lexicon: CatalogLexicon): LexiconEntry[] {
  const tokens = normaliseTokens(text)
  interface Hit {
    readonly entry: LexiconEntry
    readonly start: number
    readonly end: number
  }
  const hits: Hit[] = []
  for (const entry of lexicon.skus) {
    for (const alias of entry.aliases) {
      const words = alias.split(' ')
      if (words.length === 0) continue
      for (let start = 0; start + words.length <= tokens.length; start += 1) {
        if (words.every((word, offset) => tokens[start + offset] === word)) {
          hits.push({ entry, start, end: start + words.length })
        }
      }
    }
  }

  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
  const claimed: Array<[number, number]> = []
  const matched = new Set<string>()
  for (const hit of hits) {
    // Two products that share a word produce two hits over the *same* span; both are recorded, because
    // the buyer's word really does name both. Only a hit that falls inside a **longer** claimed span is
    // suppressed — there, the words are part of a name the buyer wrote in full.
    const sameSpan = claimed.some(([start, end]) => start === hit.start && end === hit.end)
    if (sameSpan) {
      matched.add(hit.entry.id)
      continue
    }
    if (claimed.some(([start, end]) => hit.start < end && start < hit.end)) continue
    claimed.push([hit.start, hit.end])
    matched.add(hit.entry.id)
  }
  return lexicon.skus.filter((entry) => matched.has(entry.id))
}

/**
 * Attribute values the text states, read only through the catalog's own vocabulary.
 *
 * `"Slate colourway"` sets `colour: "Slate"` because **the catalog** has a Slate product; a text that
 * says `"a nice shade of mauve"` sets nothing, and the model is what fills that gap later (if it is
 * configured). No colour list lives here, which is what keeps this from inventing a preference.
 */

export function attributesInText(
  text: string,
  lexicon: CatalogLexicon,
): { readonly colour?: string; readonly size?: string; readonly model?: string } {
  const tokens = normaliseTokens(text)
  const out: { colour?: string; size?: string; model?: string } = {}

  const colourPrefixes = ['colour', 'color', 'colourway', 'colorway', 'in']
  for (const value of lexicon.attributes.colour) {
    const words = value.normalised.split(' ')
    for (let i = 0; i + words.length <= tokens.length; i += 1) {
      if (!words.every((w, k) => tokens[i + k] === w)) continue
      const before = tokens[i - 1]
      if (before !== undefined && colourPrefixes.includes(before)) out.colour = value.raw
      // A colour word with no prefix still counts when it is unambiguous in the catalog: the buyer wrote
      // the product's own colour name.
      else if (before === undefined || !MEASURE_WORDS.has(before)) out.colour = value.raw
      break
    }
  }

  // Sizes are only read with an explicit `size` marker, because a bare `m` or `l` is a unit, a litre or a
  // stray letter far more often than it is a size.
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i - 1] !== 'size') continue
    const value = lexicon.attributes.size.find((s) => s.normalised === tokens[i])
    if (value !== undefined) out.size = value.raw
  }

  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i - 1] !== 'model') continue
    const value = lexicon.attributes.model.find((m) => m.normalised === tokens[i])
    if (value !== undefined) out.model = value.raw
  }

  return out
}
