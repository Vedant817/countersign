/**
 * `renderPacketPdf()` — spec **§8.18**, work package **WP-15d**. The one PDF per `evidence_packets` row.
 *
 * ```ts
 * const rendered = await renderPacketPdf({ packetId, decision, draft, bundle, … }, { clock })
 * // rendered.value.bytes  → evidence_packets.pdf_bytes, pdf_sha256 = rendered.value.sha256
 * ```
 *
 * ## What is in it, and why this order
 *
 * The sections below are §8.18's order. It is a reading order, and each step is one a reader asks for in
 * sequence: *what is this, who decided, on what, saying what, signed by what, showing what, check it
 * yourself, and what we are not claiming.*
 *
 * | §8.18 section | The reader's question | The data |
 * |---|---|---|
 * | 1. What this document is | "What am I holding?" | packet id, dispute id, version |
 * | 2. The decision | "Who decided, and how?" | `ruleId`, `posture`, `liability`, `rationale`, rule origin |
 * | 3. The facts compared | "On what?" | the `RouterFact`s the rule read |
 * | 4. The claims, each with its artefact id | "What is being asserted, and what backs it?" | `draft.citations` |
 * | 5. The signed chain | "Signed by what?" | l1/l2/l3a/l3b, checkout, gate decision, fingerprints |
 * | 6. The read-back | "What did the buyer approve?" | `chain.readback`, verbatim |
 * | 7. Capture screenshot slot | "Where is the photo?" | an empty labelled frame |
 * | 8. Verify it yourself | "Do I have to trust you?" | the QR and `PUBLIC_BASE_URL` + `/v/{packetId}` |
 * | 9. What this packet does not claim | "What are you hiding?" | EC-MER-4's carrier line, EC-MER-6's read-back line |
 *
 * ## Determinism, and why it is a spec requirement rather than tidiness
 *
 * **The same packet renders byte-identical output**, because §8.18 asks for a reproducible document: two
 * renders of the same packet must be comparable, or `evidence_packets.pdf_sha256` is a value that changes
 * for no reason and a re-render looks like a tamper.
 *
 * Three things had to be true to get there, and each is a specific `pdf-lib` behaviour:
 *
 * 1. **No wall clock.** `PDFDocument.create()` stamps `/CreationDate` and `/ModDate` from `new Date()`.
 *    `setCreationDate`/`setModificationDate` are called with the **injected `Clock`**, so the only source of
 *    time is the caller. `test/evidence-doc.test.ts` asserts both directions: two renders with the same
 *    clock are byte-identical, and two renders with *different* clocks are **not** — otherwise the first
 *    assertion would pass for the wrong reason.
 * 2. **No metadata that varies.** Producer, Creator, Title, Author, Subject and Keywords are all set
 *    explicitly; `pdf-lib` otherwise writes its own version string.
 * 3. **`useObjectStreams: false`.** Object streams are zlib-compressed, and a compressed stream's bytes
 *    depend on the zlib build. Uncompressed streams plus a fixed glyph subset make the output a function of
 *    the input alone.
 *
 * ## Redaction is a test, not a hope
 *
 * Spec **§8.18** ("Shows a redacted bundle: email masked, address city/country only") and **EC-PRIV-2/3**.
 * Three independent controls, because each catches a different mistake:
 *
 * - **`redactForPacket` runs on every string before it is drawn.** Not on some — on all. A renderer that
 *   redacts the "buyer" row and forgets the "errors" table has leaked exactly as much as it redacted.
 * - **The bundle is not copied in.** The PDF names artefacts and fingerprints; the signed artefacts
 *   themselves are what `/v/{packetId}` serves, selectively disclosed. Printing a full SD-JWT into a
 *   merchant-uploaded document would undo §8.18's whole redaction story.
 * - **The test extracts the text back out of the rendered bytes and greps it** (`test/evidence-doc.test.ts`),
 *   because asserting on the *inputs* proves only that the inputs were clean. The extractor decodes the
 *   glyph ids in the content stream through the document's own `/ToUnicode` CMap, which is the same
 *   mapping any PDF reader uses — so it is not a re-implementation of our draw calls.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { csError, err, ok, type Clock, type CsError, type Result } from '@countersign/core'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

import type { Citation, ClaimSource } from './citation-check'
import {
  publicPacketUrl,
  QR_ERROR_CORRECTION,
  QR_QUIET_ZONE_MODULES,
  qrMatrixFor,
  type QrMatrix,
} from './qr'
import type { Draft } from './drafter'
import type { LiabilityDecision, RouterFact } from './types'

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A4 portrait, in PDF points. §8.18 gives no size; A4 is what a merchant prints and what PayPal renders. */
export const PAGE_SIZE = { width: 595.28, height: 841.89 } as const
const MARGIN = 48
const CONTENT_WIDTH = PAGE_SIZE.width - MARGIN * 2
/** 14pt / 18pt leading. Readable when PayPal scales a thumbnail to a sidebar. */
const SIZE_BODY = 9.5
const SIZE_LABEL = 7.5
const SIZE_H1 = 11.5
const LINE_HEIGHT = 13.5

const INK = rgb(0.09, 0.09, 0.11)
const MUTED = rgb(0.42, 0.42, 0.46)
const RULE = rgb(0.78, 0.78, 0.82)
const FRAME = rgb(0.6, 0.6, 0.65)

/** The font file, committed. See `assets/fonts/FONT-LICENCE.md` for the licence and why it is a file. */
const FONT_PATH = new URL('../assets/fonts/Roboto-Regular.ttf', import.meta.url)

/** Committed input, pinned so a silent font swap is a test failure rather than an unexplained diff. */
export const FONT_SHA256 = '56a45233d29f11b4dfb86d248e921939d115778f87325e7ae8cc108383d6664d'

// ---------------------------------------------------------------------------
// Input and output
// ---------------------------------------------------------------------------

/**
 * One row of `evidence_packets`' error trail, so a rejected filing's cause is on the record.
 *
 * Rendered as `{code, retryable}` and **nothing else**: §8.0 rule 3's `NEVER_SERIALISE` list is what makes
 * `details` dangerous, and the one safe way to deal with a `details` bag that might hold a token, a key id
 * or a raw upstream body is not to redact it well — it is to never render it.
 */
export interface PacketError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
}

export interface PacketView {
  readonly packetId: string
  readonly disputeId: string
  readonly paypalDisputeId: string
  readonly version: number
  readonly decision: LiabilityDecision
  readonly draft: Draft
  readonly facts: readonly RouterFact[]
  readonly claims: readonly ClaimSource[]
  /** The §7.3 bundle, for the artefact inventory only. Never copied wholesale — see the file header. */
  readonly bundle: Readonly<Record<string, unknown>>
  /** The signer-approved read-back. §8.18 and EC-MER-6: required, never optional. */
  readonly readback: string
  readonly chain: {
    readonly l1?: string
    readonly l2?: string
    readonly l3a?: string
    readonly l3b?: string
    readonly checkoutJwt?: string
    readonly gateDecision?: string
    readonly deviceJkt?: string
    readonly agentKid?: string
    readonly viLibCommit?: string
  }
  /** `PUBLIC_BASE_URL`. The QR payload is derived from it and from `packetId`, never passed in. */
  readonly publicBaseUrl: string
  /** What a merchant would paste alongside the packet, redacted the same way as everything else. */
  readonly payerEmail?: string
  readonly payerId?: string
  readonly payerCountry?: string
  readonly payerCity?: string
  readonly errors?: readonly PacketError[]
}

export interface RenderedPacket {
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly byteLength: number
  readonly pageCount: number
  readonly qrPayload: string
  readonly qrModules: number
  /** Anything a caller should know: a redaction that fired, a section that was empty. Never thrown. */
  readonly notices: readonly string[]
}

export interface RenderDeps {
  readonly clock: Clock
  /** Overridable so a test can prove the clock is the only source of time. Never used for content. */
  readonly fontBytes?: Uint8Array
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Field names from §8.0 rule 3's `NEVER_SERIALISE` list, and `packages/core`'s `PII_KEYS`.
 *
 * Re-declared rather than imported because `packages/core` exports the *regex* and the *key list* only as
 * private module constants (`NEVER_SERIALISE` is not exported; `PII_KEYS` is, but it covers PII, not
 * credentials). Duplicating the pattern here is a real drift risk and it is the honest one to take: the
 * alternative — importing `packages/core/src/errors.ts`'s internals — would couple a PDF renderer to a
 * module that has no business knowing what a PDF is. `test/evidence-doc.test.ts` asserts the two copies
 * agree on every key the registry's own `toBody()` strips, by round-tripping a `CsError` through both.
 */
const NEVER_SERIALISE_KEY =
  /(cause|stack|secret|password|token|authorization|cookie|credential|private|key|kid|client_id|session_id|clientid)/i

const PII_KEY = /(name|address|street|city|postal|zip|phone|email)/i

/** `asha@example.com` → `a***@e***.com`, so a reader can recognise it as *their* address and nobody else's. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  if (at <= 0) return REDACTED
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  const head = local.slice(0, 1)
  const dParts = domain.split('.')
  const keep = dParts.length > 1 ? dParts.slice(0, -1) : dParts
  const tld = dParts.length > 1 ? dParts[dParts.length - 1] : ''
  return `${head}***@${keep.map((p) => `${p.slice(0, 1)}***`).join('.')}${tld === '' ? '' : `.${tld}`}`
}

const REDACTED = '[redacted]'

/**
 * A `payer_id` is a PayPal account identifier. EC-PRIV-3 permits a mask; it is not PII in the way an email
 * is, but it is a stable cross-account identifier and PayPal's own support treats it as sensitive. Four
 * leading and two trailing characters is enough for a merchant to match their own record and not enough to
 * be used against someone else's.
 */
export function maskPayerId(value: string): string {
  if (value.length <= 8) return REDACTED
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(1, value.length - 6))}${value.slice(-2)}`
}

/** A 12..19 digit run that passes Luhn is a card number; a run that does not is an order id. */
export function looksLikeCardNumber(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * A `payer_id` in free text, which `maskEmail` cannot see and which a `payer_id:` *label* check cannot
 * reach.
 *
 * This exists because of a leak the extracted-PDF test caught: the hostile fixture put a real payer id into
 * the read-back **prose** (`Buyer contact …, payer PAYER9XK2LMNOPQRSTUV`), where there is no key to key off.
 * The two existing rules missed it — it is not an email, and it has no digits long enough to look like a card
 * — and EC-PRIV-3 is explicit that the public verifier leaks no `payer_id`. A merchant pasting their own
 * account id into a dispute note is an ordinary thing to do, so the renderer has to catch it where it is
 * written rather than only where it is labelled.
 *
 * PayPal's own payer-id shape is `PAYER` followed by upper-case alphanumerics, so the pattern is tight: a
 * SKU or a rule id that happens to contain the letters `PAYER` is not touched.
 */
const BARE_PAYER_ID = /\bPAYER[A-Z0-9]{6,}\b/g

/**
 * Strip anything a public document must not carry, from **one string**.
 *
 * Four passes, in order of how cheap they are to run:
 *
 * 1. **e-mail** → masked, not removed. EC-PRIV-3 says "email masked (`a***@…`)", and a reader who sees
 *    `[redacted]` where their own address was cannot tell whether it was redacted or missing.
 * 2. **payer id** → `PAYE************UV`, in prose as well as in a labelled field.
 * 3. **card numbers** → last four only. A payment dispute is *about* an amount and a card, and the last
 *    four are what a merchant matches on; the rest is never needed and never printed.
 * 4. **bearer/basic shapes and long JWT-ish runs** → removed. `core.redactText` does the same thing for
 *    logs, and a PDF is a log that a judge reads.
 */
export function redactForPacket(text: string): string {
  let out = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
  out = out.replace(BARE_PAYER_ID, (m) => maskPayerId(m))
  out = out.replace(/\b(?:\d[ -]?){12,19}\b/g, (run) => {
    const digits = run.replace(/\D/g, '')
    return looksLikeCardNumber(digits) ? `****-****-****-${digits.slice(-4)}` : run
  })
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  out = out.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
  return out
}

/**
 * Reduce an arbitrary value to a string that is safe to draw, or `null` when it must not be drawn.
 *
 * `null` is the answer for a credential-shaped key **regardless of its value**. `packages/core`'s
 * `safeDetails` already drops those keys for HTTP responses; doing it again here means a field that
 * reached the renderer through a route nobody audited is still dropped. Fail closed, one level down.
 */
export function safeField(key: string, value: unknown): string | null {
  if (NEVER_SERIALISE_KEY.test(key)) return null
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'bigint'
        ? value.toString()
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : value === null || value === undefined
            ? ''
            : JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  const redacted = redactForPacket(text)
  return PII_KEY.test(key) && redacted === text && text.length > 0
    ? maskAllButShape(redacted)
    : redacted
}

/** For a PII-named key whose value has no recognisable shape (a name, a street): keep nothing readable. */
function maskAllButShape(text: string): string {
  return text.length <= 2
    ? REDACTED
    : `${text.slice(0, 1)}${'*'.repeat(Math.min(12, text.length - 1))}`
}

/** A SHA-256 of a fingerprint-safe value, for the "printed so a verifier can match it" columns. */
function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Encodability
// ---------------------------------------------------------------------------

/**
 * Refuse to render a string the font cannot draw, rather than dropping characters silently.
 *
 * `pdf-lib` throws deep inside `drawText` when a glyph is missing, with a message that names the font
 * rather than the sentence. Catching it here means the packet fails to render — visible, logged, retried —
 * instead of losing a `…` from a read-back on the one page a judge reads. Spec §8.17's read-back is
 * printed **verbatim**, so "verbatim" has to include the ellipsis.
 */
function assertEncodable(font: PDFFont, text: string, where: string): void {
  const supported = new Set(font.getCharacterSet())
  for (const ch of text) {
    if (ch === '\n') continue
    const cp = ch.codePointAt(0)
    if (cp === undefined || !supported.has(cp)) {
      throw new Error(
        `evidence-doc: ${where} contains U+${cp?.toString(16).toUpperCase().padStart(4, '0') ?? '????'} ` +
          `("${ch}"), which the committed font cannot draw`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// renderPacketPdf
// ---------------------------------------------------------------------------

/**
 * Render the packet. **Never throws** — a `CsError` with a registry code, per §8.0 rule 3.
 *
 * @param view the packet. Every field is redacted through {@link redactForPacket} before it is drawn.
 * @param deps `clock` is the **only** source of time. See the file header for why that is a spec
 *   requirement rather than a style choice.
 */
export async function renderPacketPdf(
  view: PacketView,
  deps: RenderDeps,
): Promise<Result<RenderedPacket, CsError>> {
  const notices: string[] = []
  try {
    const fontBytes = deps.fontBytes ?? new Uint8Array(readFileSync(FONT_PATH))
    const qrPayload = publicPacketUrl(view.publicBaseUrl, view.packetId)
    const qr = qrMatrixFor(qrPayload)

    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(fontBytes, { subset: true })

    // --- determinism: every varying field pinned to the injected clock or to a constant -----------------
    const at = deps.clock.nowSec()
    const stamp = new Date(at * 1000)
    doc.setCreationDate(stamp)
    doc.setModificationDate(stamp)
    doc.setProducer('Countersign evidence packet')
    doc.setCreator('Countersign evidence packet')
    doc.setTitle(`Evidence packet ${view.packetId} v${view.version}`)
    doc.setSubject(`PayPal dispute ${view.paypalDisputeId}`)
    doc.setAuthor('Countersign')
    doc.setKeywords(['dispute', 'evidence', 'verifiable-intent'])

    const layout = new Layout(doc, font)
    const sections = packetSections(view, qr, notices)
    for (const section of sections) layout.section(section)

    layout.finish()

    const bytes = await doc.save({ useObjectStreams: false })
    if (bytes.byteLength > MAX_PACKET_BYTES) {
      return err(
        csError(
          'CS_VALIDATION',
          `The rendered packet is ${bytes.byteLength} bytes; PayPal's per-file limit is ` +
            `${MAX_PACKET_BYTES} [V8]. EC-DSP-12 says compress and retry, not upload it.`,
          { packetId: view.packetId, byteLength: bytes.byteLength },
        ),
      )
    }
    return ok({
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      pageCount: doc.getPageCount(),
      qrPayload,
      qrModules: qr.size,
      notices,
    })
  } catch (cause) {
    return err(
      csError(
        'CS_INTERNAL',
        `The evidence packet could not be rendered: ${cause instanceof Error ? cause.message : String(cause)}`,
        { packetId: view.packetId },
        { cause },
      ),
    )
  }
}

/**
 * §8.18's 2 MB target and PayPal's 10 MB hard limit [V8].
 *
 * Two numbers on purpose. AT-M15.3 asks for "under 2 MB for a typical case", which is a *target* worth
 * asserting so a font swap or a base64 screenshot cannot quietly triple the document; and 10 MB is the
 * *limit* PayPal enforces after a 50 MB upload has already left the building.
 */
export const MAX_PACKET_BYTES = 10 * 1024 * 1024
export const TARGET_PACKET_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  readonly heading: string
  /** Drawn verbatim and wrapped. Redacted by the caller before it gets here. */
  readonly lines: readonly string[]
  /** An empty labelled frame: the capture screenshot slot (§8.18). */
  readonly frame?: { readonly caption: string; readonly height: number }
  /** The QR, drawn beside `caption`. */
  readonly qr?: { readonly matrix: QrMatrix; readonly caption: string }
  readonly rule?: boolean
}

/**
 * §8.18's sections, in §8.18's order.
 *
 * Exported (via {@link packetSectionOrder}) so `test/evidence-doc.test.ts` can assert the order without
 * duplicating it — a duplicated order is a second opinion about the document, which is the thing §8.18's
 * "mandated sections" requirement is trying to prevent.
 */
export function packetSections(
  view: PacketView,
  qr: QrMatrix,
  notices: string[],
): readonly Section[] {
  const r = (t: string): string => redactForPacket(t)
  const qrPayload = publicPacketUrl(view.publicBaseUrl, view.packetId)
  const out: Section[] = []

  out.push({
    heading: '1. What this document is',
    lines: [
      r(
        `Evidence packet ${view.packetId}, version ${view.version}, for PayPal dispute ${view.paypalDisputeId}.`,
      ),
      r(
        `Filed by the merchant through Countersign. Every line below is either a signed record or a ` +
          `template; nothing in this document was written by a language model.`,
      ),
      r(
        `Rendered from the packet's own stored bundle. The bundle itself is served, selectively disclosed, at ${qrPayload}`,
      ),
    ],
  })

  out.push({
    heading: '2. The decision',
    lines: [
      r(
        `Rule ${view.decision.ruleId}. Liability ${view.decision.liability}. Recommended posture ${view.decision.posture}.`,
      ),
      r(view.decision.rationale),
      ...view.decision.reasons.map((x) => r(`— ${x}`)),
      ...(view.decision.supersedes === undefined
        ? []
        : [
            r(
              `Without the clock or the missing evidence this would have been ${view.decision.supersedes}.`,
            ),
          ]),
    ],
    rule: true,
  })

  out.push({
    heading: '3. The facts the rule compared',
    lines:
      view.facts.length === 0
        ? [r('No citable fact was recorded for this dispute.')]
        : view.facts.map((f) => r(`${f.key} = ${f.value}   (source: ${f.source})`)),
    rule: true,
  })

  out.push({
    heading: '4. The claims, and the artefact behind each one',
    lines:
      view.draft.citations.length === 0
        ? [r('This note asserts nothing that needed a citation.')]
        : view.draft.citations.flatMap((c: Citation) => [
            r(`${c.sentence}`),
            r(
              `      cited as ${c.claimId} · artefact ${c.artefact.id} · ${c.artefact.description} · ${c.support}`,
            ),
          ]),
    rule: true,
  })

  const chainRows: string[] = []
  const c = view.chain
  chainRows.push(r(`L1 credential: ${present(c.l1)}`))
  chainRows.push(r(`L2 mandate: ${present(c.l2)}`))
  chainRows.push(r(`L3a authorisation: ${present(c.l3a)}`))
  chainRows.push(r(`L3b authorisation: ${present(c.l3b)}`))
  chainRows.push(r(`Merchant checkout signature: ${present(c.checkoutJwt)}`))
  chainRows.push(r(`Signed Gate decision: ${present(c.gateDecision)}`))
  if (c.deviceJkt !== undefined)
    chainRows.push(r(`Device key fingerprint (RFC 7638): ${c.deviceJkt}`))
  if (c.agentKid !== undefined) chainRows.push(r(`Agent key id: ${c.agentKid}`))
  if (c.viLibCommit !== undefined)
    chainRows.push(r(`Verifiable Intent library commit: ${c.viLibCommit}`))
  chainRows.push(r(`Bundle fingerprint: ${fingerprint(JSON.stringify(view.bundle))}`))
  out.push({ heading: '5. The signed chain', lines: chainRows, rule: true })

  out.push({
    heading: '6. The read-back the buyer approved',
    lines: view.readback.split('\n').map((line) => r(line.length === 0 ? ' ' : line)),
    rule: true,
  })

  out.push({
    heading: '7. Capture screenshot',
    lines: [
      r(
        'The merchant attaches the carrier or dashboard capture as a separate document. This slot is reserved for it.',
      ),
    ],
    frame: { caption: 'Screenshot slot — not populated by this renderer', height: 150 },
    rule: true,
  })

  out.push({
    heading: '8. Verify it yourself',
    lines: [
      r(`Scan the code, or open: ${qrPayload}`),
      r(
        `The page re-verifies the chain in section 5 from the stored bundle and shows each check. It needs no account and no trust in us.`,
      ),
      r(
        `Correction level ${QR_ERROR_CORRECTION}, ${qr.size}x${qr.size} modules, ${QR_QUIET_ZONE_MODULES}-module quiet zone.`,
      ),
    ],
    qr: { matrix: qr, caption: r(qrPayload) },
    rule: true,
  })

  const caveats: string[] = [
    'A tracking number in this packet was entered by the merchant. We cannot verify it against the carrier, and nothing here says the parcel was delivered.',
    'The read-back in section 6 is inside the signed mandate. Omitting it changes the mandate hash, so the verifier shows the difference.',
  ]
  if (view.payerEmail !== undefined)
    caveats.push(`Buyer account on the payment: ${maskEmail(view.payerEmail)}`)
  if (view.payerId !== undefined) caveats.push(`PayPal payer id: ${maskPayerId(view.payerId)}`)
  if (view.payerCountry !== undefined) caveats.push(`Payer country: ${r(view.payerCountry)}`)
  if (view.payerCity !== undefined) caveats.push(`Payer city: ${r(view.payerCity)}`)
  for (const e of view.errors ?? []) {
    // `code` and `retryable` only. `details` is never rendered — see `PacketError`.
    caveats.push(
      `Upstream error recorded during filing: ${r(e.code)} (retryable: ${e.retryable ? 'yes' : 'no'})`,
    )
  }
  out.push({ heading: '9. What this packet does not claim', lines: caveats.map(r) })

  if (view.draft.truncation !== undefined) {
    notices.push(
      `Note truncated from ${view.draft.truncation.writtenChars} to ${view.draft.truncation.keptChars} characters; ` +
        `${view.draft.truncation.droppedSentences} whole sentence(s) omitted.`,
    )
  }
  return out
}

/** The section headings, in order. For the test that pins §8.18's order. */
export function packetSectionOrder(): readonly string[] {
  return [
    '1. What this document is',
    '2. The decision',
    '3. The facts the rule compared',
    '4. The claims, and the artefact behind each one',
    '5. The signed chain',
    '6. The read-back the buyer approved',
    '7. Capture screenshot',
    '8. Verify it yourself',
    '9. What this packet does not claim',
  ]
}

function present(token: string | undefined): string {
  if (token === undefined || token.trim().length === 0) return 'not recorded'
  return `present, ${fingerprint(token)} (first 8: ${token.slice(0, 8)})`
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * A tiny, deterministic text layout. No reflow heuristics, no widow/orphan rules, no font-metric caching
 * that depends on load order — the only inputs are the strings, the font and the page size, which is what
 * makes the byte-identical-output assertion hold.
 *
 * Word wrap uses the font's own advance widths, so a long read-back line breaks in the same place on every
 * machine. Measuring with a hard-coded character count would break differently per font size and per string,
 * and the resulting page count would drift.
 */
class Layout {
  private pages: PDFPage[] = []
  private page: PDFPage | null = null
  private y = 0

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
  ) {}

  finish(): void {
    if (this.page === null) this.newPage()
  }

  private newPage(): void {
    this.page = this.doc.addPage([PAGE_SIZE.width, PAGE_SIZE.height])
    this.pages.push(this.page)
    this.y = PAGE_SIZE.height - MARGIN
  }

  private need(height: number): void {
    if (this.page === null) {
      this.newPage()
      return
    }
    if (this.y - height < MARGIN) this.newPage()
  }

  section(s: Section): void {
    this.need(LINE_HEIGHT * 4)
    this.draw(s.heading, SIZE_H1, INK)
    this.y -= 4
    for (const line of s.lines) {
      const safe = redactForPacket(line)
      assertEncodable(this.font, safe, `section "${s.heading}"`)
      for (const wrapped of this.wrap(safe, SIZE_BODY)) {
        this.need(LINE_HEIGHT)
        this.draw(wrapped, SIZE_BODY, INK)
      }
    }
    if (s.qr !== undefined) {
      this.drawQr(s.qr.matrix, s.qr.caption)
    }
    if (s.frame !== undefined) {
      this.need(s.frame.height)
      const page = this.current()
      page.drawRectangle({
        x: MARGIN,
        y: this.y - s.frame.height,
        width: CONTENT_WIDTH,
        height: s.frame.height,
        borderColor: FRAME,
        borderWidth: 0.7,
        borderDashArray: [3, 3],
      })
      page.drawText(s.frame.caption, {
        x: MARGIN + 8,
        y: this.y - 16,
        size: SIZE_LABEL,
        font: this.font,
        color: MUTED,
      })
      this.y -= s.frame.height + 10
    }
    if (s.rule === true) {
      this.need(12)
      const page = this.current()
      page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: PAGE_SIZE.width - MARGIN, y: this.y },
        thickness: 0.5,
        color: RULE,
      })
      this.y -= 12
    }
  }

  private current(): PDFPage {
    if (this.page === null) this.newPage()
    const p = this.page
    if (p === null) throw new Error('evidence-doc: no page')
    return p
  }

  private draw(text: string, size: number, color: ReturnType<typeof rgb>): void {
    this.need(LINE_HEIGHT)
    const page = this.current()
    this.y -= size + 3
    if (text.length > 0) page.drawText(text, { x: MARGIN, y: this.y, size, font: this.font, color })
  }

  /** Greedy word wrap on the font's advance widths. Deterministic by construction. */
  private wrap(text: string, size: number): readonly string[] {
    const max = CONTENT_WIDTH
    if (this.font.widthOfTextAtSize(text, size) <= max) return [text]
    const words = text.split(' ')
    const lines: string[] = []
    let current = ''
    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`
      if (this.font.widthOfTextAtSize(candidate, size) <= max) {
        current = candidate
        continue
      }
      if (current.length > 0) lines.push(current)
      // A single word longer than the line (a base64 run, a long token): split it on character
      // boundaries. Deterministic, and better than letting it run off the page.
      if (this.font.widthOfTextAtSize(word, size) > max) {
        let chunk = ''
        for (const ch of word) {
          if (this.font.widthOfTextAtSize(chunk + ch, size) > max && chunk.length > 0) {
            lines.push(chunk)
            chunk = ch
          } else {
            chunk += ch
          }
        }
        current = chunk
      } else {
        current = word
      }
    }
    if (current.length > 0) lines.push(current)
    return lines.length === 0 ? [''] : lines
  }

  /**
   * Draw the QR as filled squares rather than embedding a PNG.
   *
   * A rasterised PNG would (a) need a second image encoder, (b) make the byte output depend on that
   * encoder's compression, and (c) lose the crispness a PayPal reviewer sees on a printed copy. One
   * `drawRectangle` per dark module is slow and irrelevant: a 33x33 symbol is 1,089 calls.
   */
  private drawQr(matrix: QrMatrix, caption: string): void {
    const module = 3.2
    const quiet = QR_QUIET_ZONE_MODULES * module
    const side = matrix.size * module
    this.need(side + quiet * 2 + LINE_HEIGHT * 3)
    const page = this.current()
    const x0 = PAGE_SIZE.width - MARGIN - side
    const y0 = this.y - side
    page.drawRectangle({
      x: x0 - quiet,
      y: y0 - quiet,
      width: side + quiet * 2,
      height: side + quiet * 2,
      color: rgb(1, 1, 1),
    })
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        if (!matrix.dark(x, y)) continue
        page.drawRectangle({
          x: x0 + x * module,
          y: y0 + (matrix.size - 1 - y) * module,
          width: module,
          height: module,
          color: rgb(0, 0, 0),
        })
      }
    }
    this.y -= side + quiet
    assertEncodable(this.font, caption, 'QR caption')
    const cap = this.wrap(caption, SIZE_LABEL)
    for (const line of cap) {
      this.need(LINE_HEIGHT)
      this.draw(line, SIZE_LABEL, MUTED)
    }
    this.y -= 8
  }
}

// ---------------------------------------------------------------------------
// Test-facing helpers
// ---------------------------------------------------------------------------

/**
 * Load the committed font. Exported so `test/evidence-doc.test.ts` can hash exactly the bytes the renderer
 * embeds rather than re-resolving the path itself.
 */
export function committedFontBytes(): Uint8Array {
  return new Uint8Array(readFileSync(FONT_PATH))
}
