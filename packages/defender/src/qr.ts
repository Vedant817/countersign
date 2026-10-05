/**
 * The public verifier address and the QR that encodes it — spec **§8.18** ("Live re-verification"), work
 * package **WP-15d**.
 *
 * ```ts
 * const url = publicPacketUrl(env.PUBLIC_BASE_URL, packetId)   // https://…/v/pkt_…
 * const qr = qrMatrixFor(url)                                  // 25..177 square, black and white
 * ```
 *
 * ## Why the QR is here at all
 *
 * A packet is shown to a human who does not know us: a PayPal adjudicator, a chargeback analyst, or a
 * judge clicking through the demo. Every claim in the PDF is a sentence, and sentences can be argued with.
 * The QR is the one thing in the document that is **not** prose and cannot be reworded — scanning it opens
 * `/v/{packetId}`, which re-runs the §7.3 chain verification and shows the per-check result. So the QR is
 * what makes "you do not have to trust us" a thing the reader can act on rather than a thing we say.
 *
 * ## The payload is the URL and nothing else
 *
 * **`PUBLIC_BASE_URL` + `/v/{packetId}`, one string, no query, no fragment, no second link.** That is
 * asserted three ways in `test/qr.test.ts`: the decoded payload equals the address exactly; the module
 * matrix is bit-identical to the library's encoding of that address (so nothing else was drawn into it);
 * and the matrix changes if a single character of the address changes (so the first assertion is
 * discriminating rather than vacuous). A QR carrying a tracking parameter, an e-mail address, or a second
 * URL would let a party rewrite where a scan goes, and §8.15 permits exactly one link in the whole
 * document.
 *
 * ## No model, no clock, no pdf-lib
 *
 * The matrix is computed by `qrcode` and returned as booleans. `evidence-doc.ts` draws it; nothing here
 * draws anything, so the QR can be tested without rendering a page, and the renderer's determinism has
 * exactly one input — the payload — which makes the byte-identical-output assertion (§8.18) possible.
 */

import QRCode from 'qrcode'

import { publicPacketUrl } from './citation-check'

// The address is defined once, in `citation-check.ts`, because §8.15's "no URLs other than
// `PUBLIC_BASE_URL/v/…`" rule and §8.18's QR payload are the **same string** and two implementations of it
// would eventually disagree — at which point a perfectly good note gets refused for a disallowed URL and a
// QR scans to a 404. `citation-check.ts` has no dependency heavier than `bigint` formatting, so importing
// it here does not drag `qrcode` into the checker's graph.
export { publicPacketUrl }

/** A QR module grid. `true` is a dark module. Immutable, so a caller cannot corrupt a shared matrix. */
export interface QrMatrix {
  /** Side length in modules. Always odd, and 21..177 per the spec of the symbol. */
  readonly size: number
  readonly modules: readonly (readonly boolean[])[]
  /** Dark module at `(x, y)`, or `false` outside the grid (quiet zone). */
  readonly dark: (x: number, y: number) => boolean
}

/** The minimum quiet zone, in modules, ISO/IEC 18004 §9.1. */
export const QR_QUIET_ZONE_MODULES = 4

/** Error correction level. `M` ≈ 15% recovery, and the symbol stays small enough to print at 2 cm. */
export const QR_ERROR_CORRECTION = 'M' as const

/**
 * Encode one string as a QR module grid.
 *
 * @throws if the string is longer than a QR can hold at {@link QR_ERROR_CORRECTION}. A public verifier
 *   address is `https://host/v/pkt_<26 chars>` — about 50 characters — so this is unreachable in practice
 *   and exists so a future caller passing a whole bundle gets a loud failure instead of a truncated
 *   code that scans to the wrong thing. `qrcode` does throw in that case rather than silently shortening.
 */
export function qrMatrixFor(payload: string): QrMatrix {
  if (payload.length === 0) throw new Error('qr: refusing to encode an empty payload')
  const symbol = QRCode.create(payload, { errorCorrectionLevel: QR_ERROR_CORRECTION })
  const size = symbol.modules.size
  const rows: boolean[][] = []
  // `BitMatrix.get(row, col)` is the public accessor. `BitMatrix.data` is the same grid as a flat
  // `Uint8Array`, but its length and ordering are an implementation detail of the package, and indexing it
  // would make the rendered QR depend on a private layout.
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = []
    for (let x = 0; x < size; x += 1) row.push(symbol.modules.get(y, x) === 1)
    rows.push(row)
  }
  const frozen = rows.map((r) => Object.freeze([...r]) as readonly boolean[])
  return {
    size,
    modules: Object.freeze(frozen),
    dark: (x, y) => (frozen[y]?.[x] ?? false) === true,
  }
}

/**
 * Is `payload` exactly the address of packet `packetId`, and nothing else?
 *
 * Called by `evidence-doc.ts` before it draws, so the constraint is enforced by the code that draws rather
 * than by a test. A caller that has mis-wired `PUBLIC_BASE_URL` gets a `CS_VALIDATION` at render time,
 * which is before anything is uploaded, which is EC-DSP-12's whole point.
 */
export function isPacketUrl(payload: string, baseUrl: string, packetId: string): boolean {
  return payload === publicPacketUrl(baseUrl, packetId)
}

/**
 * The payload a decoded symbol must equal, for the tests. Returned rather than inlined so the assertion in
 * `test/qr.test.ts` and the assertion in `evidence-doc.ts` cannot be written differently.
 */
export function expectedPayload(baseUrl: string, packetId: string): string {
  return publicPacketUrl(baseUrl, packetId)
}
