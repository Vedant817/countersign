/**
 * Render the mandate read-back as text rather than as its markdown source.
 *
 * ## The defect this replaces
 *
 * `readBack()` returns markdown — the same string is used in the PDF, in terminal output and in an
 * email, so markdown is the right wire format for it. The page rendered it inside a `<pre>`:
 *
 * ```tsx
 * <pre className="whitespace-pre-wrap font-sans">{readBackText}</pre>
 * ```
 *
 * A `<pre>` does not interpret markdown, so a buyer saw **`Spend at most **$50.00** in total`** — the
 * asterisks literal, on the one screen whose entire job is to be read and approved before signing. The
 * sentence the buyer authorises is the product's central artefact (§D-008 pins it byte for byte), and it
 * was being displayed as its own source code.
 *
 * ## Why not a markdown library
 *
 * `readBack` emits exactly two constructs — `**bold**` and hard line breaks — and a full parser would be
 * a dependency, a configuration surface and a class of injection risk for two rules. It would also
 * silently *accept* anything else the read-back might grow into, which is the opposite of what is wanted:
 * the supported subset should be visible in one small file that fails loudly on anything unexpected.
 *
 * ## Why this cannot be an XSS hole
 *
 * The output is React elements, never `dangerouslySetInnerHTML` and never a string of HTML. `**` markers
 * are matched by index and the enclosed text is emitted as a child, so it is escaped by React exactly
 * like any other text node. Nothing here can produce markup the read-back did not spell.
 *
 * The read-back is generated from the mandate by our own code, so it is not attacker-controlled today —
 * but writing this the safe way costs nothing and removes the need to re-derive that argument if a
 * merchant name ever reaches it, which it already does (`readBack` takes `merchants`).
 */

/** One line of read-back, with `**bold**` spans rendered as `<strong>` and everything else as text. */
function renderLine(line: string, key: number): React.ReactNode {
  // Split on the delimiters but keep them, so an odd number of `**` degrades to literal text rather
  // than swallowing the rest of the line.
  const parts = line.split(/(\*\*[^*]+\*\*)/g)
  return (
    <span key={key}>
      {parts.map((part, index) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={index} className="font-semibold text-ink">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  )
}

/**
 * The read-back, laid out as the buyer will read it.
 *
 * Blank lines become spacing rather than empty text nodes, so the paragraph structure of the source
 * survives into the page without a `<pre>`'s monospace alignment.
 */
export function ReadBackText({ text }: { readonly text: string }): React.ReactNode {
  const lines = text.split('\n')
  return (
    <div className="mt-3 space-y-1.5 text-sm leading-relaxed text-ink-soft">
      {lines.map((line, index) =>
        line.trim() === '' ? (
          <div key={index} className="h-2" aria-hidden="true" />
        ) : (
          <p key={index}>{renderLine(line, index)}</p>
        ),
      )}
    </div>
  )
}
