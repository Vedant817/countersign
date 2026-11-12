/**
 * One plain sentence out of a mandate read-back, for a chat transcript.
 *
 * ## Why this exists at all
 *
 * The agent's first `thought` used to be built as `readback.split('\n')[0]`. The first line of
 * `readBack()` is its **heading** — `**What you are authorising**`
 * (`packages/compiler/src/readback.ts`) — so every run opened with the literal sentence
 *
 * ```
 * Reading your mandate. **What you are authorising**
 * ```
 *
 * which is a markdown header with nothing under it: it tells the buyer nothing about what they signed,
 * and the cap they actually chose never appeared in the transcript at all.
 *
 * ## Why the rule is structural, not textual
 *
 * The naive fix — `startsWith('**What')` — is what `apps/web/app/agent/agent-chat.tsx` did, and it is
 * the same defect one file over: a hardcoded English prefix silently stops matching the moment the
 * read-back wording changes, and the raw markdown reaches the buyer as-is.
 *
 * So this module keys off **markdown structure instead of English**: a line that is *entirely* a bold
 * span is a heading, and the first line that is not one is content. `**Spend at most **$50.00** in
 * total**` is a heading; `Spend at most **$50.00** in total` is the cap.
 */

/** A line that is one whole bold span, optionally trailing punctuation: `**Not covered**`. */
const HEADING_ONLY = /^\*\*[^*].*\*\*[.!:]?$/

/** `**bold**` markers, list bullets, and the link/markdown noise a read-back may carry. */
const MARKUP = /\[\[[^\]]*\]\]|\*\*|`|__|^\s*[-*]\s+/g

/** How long a transcript line may be before it is truncated with an ellipsis. */
export const READBACK_SUMMARY_MAX_CHARS = 160

/**
 * The first substantive line of a read-back, as plain text.
 *
 * @param readback the exact string the buyer signed (`readBack()`'s output).
 * @param maxChars truncation budget; the result is cut on a word boundary when it can be.
 * @returns a single line with no markdown and no heading, or `''` when the read-back has no content
 *   line (an empty read-back is a bug upstream, and an empty string here is honest about it rather
 *   than inventing text).
 */
export function readbackSummaryLine(
  readback: string,
  maxChars = READBACK_SUMMARY_MAX_CHARS,
): string {
  const line = readback
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '' && !HEADING_ONLY.test(entry))

  if (line === undefined) return ''

  const plain = line.replaceAll(MARKUP, '').replaceAll(/\s+/g, ' ').trim()
  if (plain.length <= maxChars) return plain

  const cut = plain.slice(0, maxChars)
  const lastSpace = cut.lastIndexOf(' ')
  // Cut on a word boundary when the last word would not be truncated to nothing.
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
