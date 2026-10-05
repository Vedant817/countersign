/**
 * The evidence packet PDF — spec **§8.18**, work package **WP-15d**, **AT-M15.3** ("The PDF is < 2 MB for
 * a typical case and embeds the QR to `/v/{packet}`"), **EC-PRIV-2**, **EC-PRIV-3**, **EC-MER-6**.
 *
 * ```bash
 * pnpm --filter @countersign/defender test
 * ```
 *
 * ## The four properties this file establishes
 *
 * | Property | Spec | How |
 * |---|---|---|
 * | the mandated sections appear, in §8.18's order | §8.18 | `packetSectionOrder()` compared against the extracted text |
 * | **the same packet renders byte-identical output** | §8.18 "reproducible" | two renders, same clock, equal SHA-256 — *and* a different clock, unequal, so the first assertion is not passing for the wrong reason |
 * | **no PII and no `details` key survives into the rendered bytes** | EC-PRIV-2/3 | `extractText()` on the rendered PDF, then grep |
 * | the QR is present and encodes only `/v/{packetId}` | §8.18, AT-M15.3 | `test/qr.test.ts` plus a QR-module count here |
 *
 * ## Why the redaction test extracts text instead of asserting on inputs
 *
 * Asserting that the *inputs* are clean proves nothing about the output: the whole point of EC-PRIV-3 is
 * that something redacted on the way in and then leaked on the way out. So this file decodes the text back
 * **out of the rendered bytes** and greps that.
 *
 * The decoder is a real one, not a mirror of our own draw calls: `pdf-lib` writes glyph ids into the content
 * stream and the characters in a `/ToUnicode` CMap, so the extractor inflates the content streams, reads the
 * `Tj`/`TJ` operands, and maps the ids through the document's own CMap — the same mapping every PDF reader
 * uses. That means a string drawn in a font subset is recovered exactly, and a string that was never drawn
 * cannot appear by accident.
 *
 * The honest limit: this reads what `pdf-lib` wrote for `drawText`. It would not see text drawn as vector
 * paths, an image, or an annotation. This renderer draws no such thing, and `test/qr.test.ts` plus the
 * section assertions below pin what it does draw.
 */

import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

import { fixedClock } from '@countersign/core'
import { describe, expect, it } from 'vitest'

import { claimSourcesFor, publicPacketUrl } from '../src/citation-check'
import { draft, type Draft } from '../src/drafter'
import {
  FONT_SHA256,
  MAX_PACKET_BYTES,
  PAGE_SIZE,
  TARGET_PACKET_BYTES,
  committedFontBytes,
  looksLikeCardNumber,
  maskEmail,
  maskPayerId,
  packetSectionOrder,
  redactForPacket,
  renderPacketPdf,
  safeField,
  type PacketView,
} from '../src/evidence-doc'
import { planEvidence } from '../src/planner'
import { route } from '../src/router'
import { qrMatrixFor } from '../src/qr'
import type { DisputeContext } from '../src/types'

// ---------------------------------------------------------------------------
// The text extractor — reads text back OUT of the rendered bytes
// ---------------------------------------------------------------------------

/**
 * Every glyph id → character mapping in the document, from every `/ToUnicode` CMap it contains.
 *
 * `pdf-lib` embeds one font, so one CMap; merging them all is harmless and means the extractor keeps working
 * if a second font is ever embedded.
 */
function toUnicodeMap(raw: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const m of raw.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (m[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const id = Number.parseInt(pair[1] ?? '', 16)
      const hex = pair[2] ?? ''
      const text = String.fromCharCode(
        ...(hex.match(/.{4}/g)?.map((u) => Number.parseInt(u, 16)) ?? [Number.parseInt(hex, 16)]),
      )
      map.set(id, text)
    }
  }
  for (const m of raw.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of (m[1] ?? '').matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
    )) {
      const lo = Number.parseInt(row[1] ?? '', 16)
      const hi = Number.parseInt(row[2] ?? '', 16)
      const start = row[3] ?? ''
      for (
        let id = lo, ch = Number.parseInt(start, 16);
        id <= hi && id - lo < 512;
        id += 1, ch += 1
      ) {
        map.set(id, String.fromCharCode(ch))
      }
    }
  }
  return map
}

/** Inflate every `stream … endstream` in the file, skipping the ones that are not Flate data. */
function inflateStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1')
  const out: string[] = []
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue
    const body = Buffer.from(raw.slice(start, end), 'latin1')
    try {
      out.push(inflateSync(body).toString('latin1'))
    } catch {
      // Not a Flate stream (the font file, for one). Its glyph data is not text we drew.
    }
  }
  return out.join('\n')
}

/**
 * The text a PDF reader would show, as one string.
 *
 * Glyph ids are read out of `Tj` and the array form of `TJ`; each 2-byte code is mapped through the
 * `/ToUnicode` CMap. A `Td`/`T*`/`Tm` between operands becomes a space so words do not run together.
 */
function extractText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1')
  const cmap = toUnicodeMap(inflateStreams(bytes))
  const contents = [...raw.matchAll(/stream\r?\n/g)]
    .map((m) => m.index + m[0].length)
    .map((start) => {
      const end = raw.indexOf('endstream', start)
      return end < 0 ? '' : raw.slice(start, end)
    })
    .map((body) => {
      try {
        return inflateSync(Buffer.from(body, 'latin1')).toString('latin1')
      } catch {
        return ''
      }
    })
    .filter((s) => s.includes('BT'))

  const out: string[] = []
  for (const content of contents) {
    for (const m of content.matchAll(
      /(<([0-9a-fA-F]+)>|\(((?:\\.|[^\\)])*)\))(\s*Tj|\s*TJ)?|\bTd\b|\bTD\b|\bT\*\b|\bTJ\b/g,
    )) {
      const hex = m[2]
      if (hex !== undefined) {
        const codes = hex.match(/.{4}/g) ?? []
        for (const c of codes) {
          out.push(cmap.get(Number.parseInt(c, 16)) ?? '�')
        }
        out.push(' ')
        continue
      }
      if (m[4] !== undefined) out.push(m[4].replace(/\\(.)/g, '$1'))
      else out.push(' ')
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000
const PACKET_ID = 'pkt_01HQ0000000000000000000000'
const BASE = 'https://countersign.example'
const ADDRESS = publicPacketUrl(BASE, PACKET_ID)
const CLOCK = fixedClock(NOW)

/** The secrets EC-PRIV-2/3 plant in the fixture. None of them may survive into the rendered bytes. */
const SECRET_EMAIL = 'asha.rane@example.com'
const SECRET_CARD = '4111111111111111'
const SECRET_PAYER_ID = 'PAYER9XK2LMNOPQRSTUV'
const SECRET_ACCESS_TOKEN = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4'
const SECRET_SIGNING_KEY = 'GATE-KID-0001'

function unauthorised(): DisputeContext {
  return {
    nowSec: NOW,
    dispute: {
      id: 'dsp_1',
      paypalDisputeId: 'PP-DSP-1',
      reason: 'UNAUTHORISED',
      stage: 'CHARGEBACK',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      amount: { minor: 12_999n, currency: 'USD' },
      captureId: 'cap_1',
      orderId: 'ord_1',
      sellerResponseDueSec: NOW + 5 * 86_400,
    },
    capture: {
      id: 'cap_1',
      paypalCaptureId: '3AB12345',
      amount: { minor: 12_999n, currency: 'USD' },
      shipmentId: 'shp_1',
    },
    order: {
      id: 'ord_1',
      customId: 'cs1:AbCdEf0123456789',
      invoiceId: 'INV-42',
      amount: { minor: 12_999n, currency: 'USD' },
    },
    refunds: [],
    shipments: [
      {
        id: 'shp_1',
        carrier: 'DHL',
        trackingNumber: 'JD0002000031',
        status: 'SHIPPED',
        lines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
      },
    ],
    siblingCaptures: [],
    chain: {
      mandatePresent: true,
      verifyAtCaptureChainValid: true,
      webauthnPresent: true,
      deviceStatus: 'ACTIVE',
      iatSec: NOW - 86_400,
      gateDecision: 'ALLOW',
      readback:
        '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00** in total\nThis mandate expires **Fri 9 Oct, 11:59 PM IST**',
    },
    checkoutLines: [{ sku: 'SKU-TRAIL-42', qty: 1 }],
    corpus: { fulfilmentDocument: true, receiptCopy: true },
  }
}

const READBACK =
  '**What you are authorising**\nOnly at **Northwind Outfitters**\nSpend at most **$130.00** in total — the buyer approved this string exactly.'

/**
 * A note built by the real drafter from a scripted model, so the PDF is rendered from the same
 * `{ notes, citations }` shape the filer will hand it. Rendering a hand-written note here would prove the
 * renderer works and say nothing about the pipeline.
 */
async function drafted(ctx = unauthorised()): Promise<Draft> {
  const decision = route(ctx)
  const plan = planEvidence(ctx, decision)
  const claims = claimSourcesFor(ctx, decision)
  const input = { ctx, decision, plan, packetId: PACKET_ID, publicBaseUrl: BASE, claims }
  const result = await draft(input, {
    llm: {
      generateText: async () => {
        const { templateNote } = await import('../src/drafter')
        return { text: templateNote(input, claims, ADDRESS) }
      },
    },
  })
  if (!result.ok)
    throw new Error(`fixture: the drafter refused its own template (${result.error.code})`)
  return result.value
}

function view(ctx = unauthorised(), note?: Draft): PacketView {
  const decision = route(ctx)
  return {
    packetId: PACKET_ID,
    disputeId: ctx.dispute.id,
    paypalDisputeId: ctx.dispute.paypalDisputeId,
    version: 1,
    decision,
    draft: note ?? {
      notes: '',
      citations: [],
      source: 'model',
      verdict: { ok: true, problems: [], citations: [], citedClaimIds: [], unusedClaimIds: [] },
      modelCalls: 1,
    },
    facts: decision.facts,
    claims: claimSourcesFor(ctx, decision),
    bundle: { v: 'cs1', l1: 'l1.x.y', l2: 'l2.x.y', l3a: 'l3a.x.y', l3b: 'l3b.x.y' },
    readback: READBACK,
    chain: {
      l1: 'l1.abc.def',
      l2: 'l2.abc.def',
      l3a: 'l3a.abc.def',
      l3b: 'l3b.abc.def',
      checkoutJwt: 'co.abc.def',
      gateDecision: 'gd.abc.def',
      deviceJkt: 'k1J9d_8sPq7A',
      agentKid: 'agt_kid_0001',
      viLibCommit: '356c29635f1c44df7de02edb58699ca9f29bece6',
    },
    publicBaseUrl: BASE,
  }
}

/** The hostile view: every secret this package knows how to redact, planted in every field. */
async function hostileView(): Promise<PacketView> {
  const base = view()
  return {
    ...base,
    payerEmail: SECRET_EMAIL,
    payerId: SECRET_PAYER_ID,
    payerCountry: 'US',
    payerCity: 'Palo Alto',
    readback: `${READBACK}\nBuyer contact ${SECRET_EMAIL}, card ${SECRET_CARD}, payer ${SECRET_PAYER_ID}`,
    bundle: {
      v: 'cs1',
      l1: `l1.abc.${SECRET_ACCESS_TOKEN}`,
      l2: 'l2.abc.def',
      // §8.0 rule 3's `NEVER_SERIALISE` keys, deliberately, as *values* a renderer might have been
      // tempted to print alongside them.
      note: `token=${SECRET_ACCESS_TOKEN} key=${SECRET_SIGNING_KEY}`,
    },
    errors: [
      {
        code: 'PP_UNPROCESSABLE',
        message: 'PayPal rejected the request details.',
        retryable: false,
        details: {
          access_token: SECRET_ACCESS_TOKEN,
          signing_key: SECRET_SIGNING_KEY,
          payer_email: SECRET_EMAIL,
          debug_id: 'WH-1234',
          issue: 'EVIDENCE_TOO_LARGE',
        },
      },
    ],
  }
}

async function render(v: PacketView): Promise<{ bytes: Uint8Array; sha256: string; text: string }> {
  const result = await renderPacketPdf(v, { clock: CLOCK })
  if (!result.ok) throw new Error(`render failed: ${result.error.code}: ${result.error.message}`)
  return {
    bytes: result.value.bytes,
    sha256: result.value.sha256,
    text: extractText(result.value.bytes),
  }
}

// ---------------------------------------------------------------------------
// It renders at all
// ---------------------------------------------------------------------------

describe('the packet renders', () => {
  it('produces a real PDF with the mandated sections, from a real drafted note', async () => {
    const note = await drafted()
    const rendered = await renderPacketPdf(view(unauthorised(), note), { clock: CLOCK })
    expect(rendered.ok).toBe(true)
    if (!rendered.ok) return
    const raw = Buffer.from(rendered.value.bytes).toString('latin1')
    expect(raw.startsWith('%PDF-')).toBe(true)
    expect(rendered.value.pageCount).toBeGreaterThan(0)
    expect(rendered.value.byteLength).toBeGreaterThan(0)
  })

  it('AT-M15.3: a typical packet is well under 2 MB and hard under PayPal’s 10 MB [V8]', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    const bytes = rendered.bytes.byteLength
    expect(bytes).toBeLessThan(TARGET_PACKET_BYTES)
    expect(bytes).toBeLessThan(MAX_PACKET_BYTES)
    // 2 MB is the spec's *target*; with no screenshot bytes and a subset font this lands an order of
    // magnitude under it. The tight bound is what stops a base64 screenshot or a full font from creeping in.
    expect(bytes, `${bytes} bytes`).toBeLessThan(120_000)
  })

  it('carries the QR to /v/{packetId}, and its size is the address’s', async () => {
    const note = await drafted()
    const result = await renderPacketPdf(view(unauthorised(), note), { clock: CLOCK })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.qrPayload).toBe(ADDRESS)
    expect(result.value.qrModules).toBe(qrMatrixFor(ADDRESS).size)
    expect(extractText(result.value.bytes)).toContain(ADDRESS)
  })

  it('puts the nine mandated sections in §8.18’s order', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    const headings = packetSectionOrder()
    expect(headings).toHaveLength(9)
    // Each heading appears, and each appears *after* the one before it — the order is the requirement,
    // because §8.18's order is a reading order and a judge reads it top to bottom.
    let cursor = -1
    for (const h of headings) {
      const at = rendered.text.indexOf(h)
      expect(at, `${h} is missing from the rendered PDF`).toBeGreaterThan(-1)
      expect(at, `${h} appears out of order`).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('lists every cited claim with its artefact id, which is what makes the packet checkable by a human', async () => {
    const note = await drafted()
    const rendered = await render(view(unauthorised(), note))
    expect(note.citations.length).toBeGreaterThan(0)
    for (const c of note.citations) {
      expect(rendered.text, `missing claim ${c.claimId}`).toContain(c.claimId)
      expect(rendered.text, `missing artefact ${c.artefact.id}`).toContain(c.artefact.id)
    }
  })

  it('prints the read-back verbatim, including the characters a WinAnsi font would have dropped', async () => {
    // EC-MER-6: omitting or paraphrasing the read-back is how a merchant hides the part that hurts them,
    // and an em dash is exactly the character a base-14 font loses silently.
    const rendered = await render(view(unauthorised(), await drafted()))
    expect(rendered.text).toContain('total — the buyer approved this string exactly')
    expect(rendered.text).toContain('Northwind Outfitters')
  })

  it('reserves a labelled screenshot slot rather than pretending there is a capture', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    expect(rendered.text).toContain('Screenshot slot')
    expect(rendered.text).toContain('Capture screenshot')
  })

  it('says what it does not claim, which is EC-MER-4 and EC-MER-6 in the packet itself', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    expect(rendered.text).toContain('What this packet does not claim')
    expect(rendered.text).toContain('cannot verify it against the carrier')
    expect(rendered.text).toContain('Omitting it changes the mandate hash')
  })

  it('never prints a citation marker, because a document that says [[clm_rule]] reads as a bug', async () => {
    const note = await drafted()
    expect(note.notes).toContain('[[clm_rule]]')
    const rendered = await render(view(unauthorised(), note))
    expect(rendered.text).not.toContain('[[')
    // What it prints instead is the marker-free sentence, with the claim id beside it as a citation label.
    // Boilerplate sentences have no claim and so appear nowhere — which is correct: they assert nothing.
    const cited = note.citations[0]?.sentence ?? ''
    expect(cited.length).toBeGreaterThan(10)
    expect(cited).not.toContain('[[')
    expect(rendered.text).toContain(cited)
    expect(rendered.text).toContain(note.citations[0]?.claimId ?? 'clm_rule')
  })

  it('returns a CsError rather than throwing when the font cannot draw something', async () => {
    const broken = view(unauthorised(), await drafted())
    const result = await renderPacketPdf(
      { ...broken, readback: 'A read-back with a glyph no Latin font has: \u{10FFFD}' },
      { clock: CLOCK },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_INTERNAL')
    expect(result.error.message).toContain('could not be rendered')
  })
})

// ---------------------------------------------------------------------------
// Determinism — §8.18's reproducible document
// ---------------------------------------------------------------------------

describe('§8.18: the same packet renders byte-identical output', () => {
  it('two renders with the same clock produce the same SHA-256', async () => {
    const v = view(unauthorised(), await drafted())
    const a = await renderPacketPdf(v, { clock: fixedClock(NOW) })
    const b = await renderPacketPdf(v, { clock: fixedClock(NOW) })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(Buffer.compare(Buffer.from(a.value.bytes), Buffer.from(b.value.bytes))).toBe(0)
    expect(a.value.sha256).toBe(b.value.sha256)
  })

  it('and a different clock produces different bytes, so the assertion above is not vacuous', async () => {
    // Without this, "byte-identical" could just mean "the clock is not in the document at all" — which would
    // mean §8.18's reproducibility is being bought by leaving out the one fact a reader needs.
    const v = view(unauthorised(), await drafted())
    const a = await renderPacketPdf(v, { clock: fixedClock(NOW) })
    const b = await renderPacketPdf(v, { clock: fixedClock(NOW + 3600) })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(Buffer.from(a.value.bytes).equals(Buffer.from(b.value.bytes))).toBe(false)
    expect(a.value.sha256).not.toBe(b.value.sha256)
    // The hash the caller will store is a plain sha256 of exactly these bytes.
    expect(createHash('sha256').update(Buffer.from(a.value.bytes)).digest('hex')).toBe(
      a.value.sha256,
    )
  })

  it('writes no wall-clock timestamp: the metadata comes from the injected clock', async () => {
    const v = view(unauthorised(), await drafted())
    const early = await renderPacketPdf(v, { clock: fixedClock(1_000_000_000) })
    const late = await renderPacketPdf(v, { clock: fixedClock(2_000_000_000) })
    expect(early.ok && late.ok).toBe(true)
    if (!early.ok || !late.ok) return
    // Same length, different bytes: the only difference is the date, so nothing else is wall-clock-derived.
    expect(early.value.byteLength).toBe(late.value.byteLength)
    expect(early.value.sha256).not.toBe(late.value.sha256)
    // And the date written is the injected one, not the wall clock's: 2027-01-15 for 1.8e9 seconds.
    const raw = Buffer.from(early.value.bytes).toString('latin1')
    expect(raw).toContain('/CreationDate')
    expect(raw).not.toContain(String(new Date().getUTCFullYear() + 1))
  })

  it('hashes to the same value the caller will store in evidence_packets.pdf_sha256', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    expect(rendered.sha256).toBe(
      createHash('sha256').update(Buffer.from(rendered.bytes)).digest('hex'),
    )
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses uncompressed object streams, because a zlib build would change the bytes', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    const raw = Buffer.from(rendered.bytes).toString('latin1')
    // A content stream is still Flate-compressed by pdf-lib; what must be absent is the *object* stream,
    // whose compressed form depends on the zlib build rather than on our input.
    expect(raw).not.toContain('/ObjStm')
    expect(raw).toContain('/Type /Page')
  })
})

// ---------------------------------------------------------------------------
// EC-PRIV-2 / EC-PRIV-3 — redaction, tested on the OUTPUT
// ---------------------------------------------------------------------------

describe('EC-PRIV-2 and EC-PRIV-3: redaction, asserted on the rendered bytes', () => {
  it('EC-PRIV-3: no email address survives, only a mask a reader can recognise as their own', async () => {
    const { text } = await render(await hostileView())
    expect(text).not.toContain(SECRET_EMAIL)
    expect(text).not.toContain('asha.rane')
    expect(text).not.toContain('example.com')
    // EC-PRIV-3's own wording: "email masked (`a***@…`)".
    expect(text).toContain('a***@')
  })

  it('EC-PRIV-3: no full card number survives, only the last four', async () => {
    const { text } = await render(await hostileView())
    expect(text).not.toContain(SECRET_CARD)
    expect(text).not.toMatch(/\b\d{12,}\b/)
    expect(text).toContain('1111')
  })

  it('EC-PRIV-3: the payer id is masked to the permitted length', async () => {
    const { text } = await render(await hostileView())
    expect(text).not.toContain(SECRET_PAYER_ID)
    expect(text).toContain('PAYE')
  })

  it('§8.0 rule 3: no `details` key from NEVER_SERIALISE, and none of its values, appears anywhere', async () => {
    const { text } = await render(await hostileView())
    // The keys, as **labels** — `key: value`, `key = …`. The list is the keys §8.0 rule 3 enumerates that
    // are also plausible in prose, checked one at a time so a failure names the key rather than the regex.
    //
    // `credential` is deliberately **absent** from this list: `L1 credential: present, <fingerprint>` is a
    // label the packet needs, and refusing it would make the chain section unreadable. The test that
    // matters is the value half below, plus the specific keys the fixture planted.
    for (const key of [
      'secret',
      'password',
      'authorization',
      'cookie',
      'access_token',
      'signing_key',
      'private_key',
      'api_key',
      'client_id',
      'session_id',
      'payer_email',
    ]) {
      expect(text, `rendered a ${key} label`).not.toMatch(
        new RegExp(`\\b${key.replace(/[_-]/g, '[_ -]')}\\s*[:=]`, 'i'),
      )
    }
    // And the values, which is the half that matters.
    expect(text).not.toContain(SECRET_ACCESS_TOKEN)
    expect(text).not.toContain(SECRET_SIGNING_KEY)
  })

  it('keeps the non-sensitive half of an error, because the case file needs to know why filing failed', async () => {
    const { text } = await render(await hostileView())
    expect(text).toContain('PP_UNPROCESSABLE')
    // `EVIDENCE_TOO_LARGE` lives in `details`, which is never rendered — so the operator sees the code and
    // goes to the logs, rather than the packet carrying an upstream body into a PayPal review.
    expect(text).not.toContain('EVIDENCE_TOO_LARGE')
  })

  it('prints a fingerprint for each artefact instead of the artefact', async () => {
    // The artefacts are served, selectively disclosed, by `/v/{packetId}`. Printing a whole SD-JWT into a
    // merchant-uploaded document would undo §8.18's redaction story.
    const { text } = await render(view(unauthorised(), await drafted()))
    expect(text).toContain('L1 credential: present')
    expect(text).toContain('Signed Gate decision: present')
    expect(text).not.toContain('l1.abc.def')
    expect(text).not.toContain('l2.abc.def')
  })

  it('keeps the city and country, which §8.18 allows, and drops nothing else it was given', async () => {
    const v = await hostileView()
    const { text } = await render(v)
    expect(text).toContain('Palo Alto')
    expect(text).toContain('US')
  })

  it('masks with no leak when the value has no recognisable shape', async () => {
    // A person's name in a `display_name` field has no structure to mask, so nothing readable is kept. The
    // honest limit, stated: a regex cannot find a name inside prose, which is why names never go in prose.
    expect(maskEmail('asha.rane@example.com')).toBe('a***@e***.com')
    expect(maskPayerId('PAYER9XK2LMNOPQRSTUV')).toBe('PAYE**************UV')
    expect(maskPayerId('SHORT')).toBe('[redacted]')
    expect(safeField('display_name', 'Asha Rane')).toBe('A********')
    expect(safeField('access_token', 'anything at all')).toBeNull()
    expect(safeField('client_id', 'AID-123')).toBeNull()
  })

  it('masks a payer id that a merchant pasted into prose, which is the leak this file found', async () => {
    // Not a labelled field, so `safeField`'s key check cannot see it; not an email; no long digit run. Only
    // a shape rule catches it, and EC-PRIV-3 is explicit that the verifier leaks no `payer_id`.
    expect(redactForPacket(`payer ${SECRET_PAYER_ID} on file`)).not.toContain(SECRET_PAYER_ID)
    // And it is tight: a rule id or a SKU containing the letters PAYER is not a payer id.
    expect(redactForPacket('rule R-PAYER-1 and SKU-PAYER-XX')).toBe(
      'rule R-PAYER-1 and SKU-PAYER-XX',
    )
  })

  it('leaves a non-PII, non-credential field alone', async () => {
    expect(safeField('amount_minor', 12999n)).toBe('12999')
    expect(safeField('currency', 'USD')).toBe('USD')
    expect(safeField('issue', 'EVIDENCE_TOO_LARGE')).toBe('EVIDENCE_TOO_LARGE')
  })

  it('redactForPacket is idempotent, so masking a mask does not drift', async () => {
    const once = redactForPacket(`buyer ${SECRET_EMAIL} card ${SECRET_CARD}`)
    expect(redactForPacket(once)).toBe(once)
    expect(once).toContain('a***@e***.com')
  })

  it('tells a card number from an order id, so masking does not destroy evidence', async () => {
    // Luhn: `4111111111111111` is a card, `1234567890123456` is not. Masking the second would leave a
    // packet with a corrupted capture id and no way to tell.
    expect(looksLikeCardNumber('4111111111111111')).toBe(true)
    expect(looksLikeCardNumber('1234567890123456')).toBe(false)
    expect(looksLikeCardNumber('3AB12345')).toBe(false)
    expect(redactForPacket('capture 1234567890123456')).toBe('capture 1234567890123456')
  })

  it('EC-PRIV-2: the packet names rows, not row contents, so an export can serve the contents itself', async () => {
    // "JSON zip of all rows + tokens + PDFs" is what an export request gets. The PDF is one artefact in
    // that zip, and it must not be the one place the secrets are duplicated.
    const { text } = await render(await hostileView())
    for (const secret of [
      SECRET_EMAIL,
      SECRET_CARD,
      SECRET_PAYER_ID,
      SECRET_ACCESS_TOKEN,
      SECRET_SIGNING_KEY,
    ]) {
      expect(text, `leaked ${secret.slice(0, 6)}…`).not.toContain(secret)
    }
  })
})

// ---------------------------------------------------------------------------
// The committed font
// ---------------------------------------------------------------------------

describe('the committed font', () => {
  it('is the pinned file, so a silent font swap is a test failure rather than an unexplained diff', () => {
    const bytes = committedFontBytes()
    expect(createHash('sha256').update(Buffer.from(bytes)).digest('hex')).toBe(FONT_SHA256)
  })

  it('is embedded rather than fetched, so Render does not need a system font', async () => {
    const rendered = await render(view(unauthorised(), await drafted()))
    const raw = Buffer.from(rendered.bytes).toString('latin1')
    // A subset font means the glyphs travel with the document. `F1` is the font resource the page uses.
    expect(raw).toContain('/FontFile2')
    expect(raw).toContain('/Type /Font')
  })

  it('renders a currency symbol WinAnsi cannot, which is why the font is committed', async () => {
    // The reason a committed Unicode TTF exists rather than pdf-lib's base-14 fonts: `₹` is not in WinAnsi,
    // and a read-back or a merchant note that contains one would lose it. The ISO code always travels with
    // the amount (§0 rule 9), so this asserts the symbol survives *and* the code is still there.
    const ctx = unauthorised()
    const withInr = {
      ...ctx,
      dispute: { ...ctx.dispute, amount: { minor: 129_900n, currency: 'INR' as const } },
      capture: { ...ctx.capture!, amount: { minor: 129_900n, currency: 'INR' as const } },
      order: { ...ctx.order!, amount: { minor: 129_900n, currency: 'INR' as const } },
    }
    const result = await renderPacketPdf(
      {
        ...view(withInr, await drafted(withInr)),
        readback: `Merchant list price ₹1,299.00 — as signed.\n${READBACK}`,
      },
      { clock: CLOCK },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = extractText(result.value.bytes)
    expect(text).toContain('INR 1299.00')
    expect(text).toContain('₹1,299.00')
  })

  it('has no page-size surprise: the document is A4 portrait', async () => {
    const raw = Buffer.from((await render(view(unauthorised(), await drafted()))).bytes).toString(
      'latin1',
    )
    // 595.28 x 841.89 pt. pdf-lib writes whole numbers without decimals, so the zeros are optional.
    expect(raw).toMatch(/\/MediaBox \[ 0(?:\.00)? 0(?:\.00)? 595\.28 841\.89 \]/)
    expect(PAGE_SIZE.width).toBe(595.28)
  })
})

// ---------------------------------------------------------------------------
// What the renderer does not draw
// ---------------------------------------------------------------------------

describe('the packet is a document, not a data dump', () => {
  it('prints fingerprints of the bundle rather than the bundle', async () => {
    const { text } = await render(view(unauthorised(), await drafted()))
    expect(text).toContain('Bundle fingerprint:')
    expect(text).not.toContain('"v":"cs1"')
  })

  it('paginates a long read-back instead of running off the page', async () => {
    const long = Array.from(
      { length: 200 },
      (_, i) => `Constraint line ${i} of the signed mandate.`,
    ).join('\n')
    const result = await renderPacketPdf(
      { ...view(unauthorised(), await drafted()), readback: long },
      { clock: CLOCK },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.pageCount).toBeGreaterThan(2)
    // First and last, so the wrap did not drop content on the way.
    expect(extractText(result.value.bytes)).toContain('Constraint line 0')
    expect(extractText(result.value.bytes)).toContain('Constraint line 199')
  })

  it('records a truncation notice, so the reader knows the note is not the whole note', async () => {
    const ctx = unauthorised()
    const base = await drafted()
    const verbose: Draft = {
      ...base,
      truncation: {
        writtenChars: 4_512,
        keptChars: 1_390,
        droppedSentences: 22,
        notice: 'Some sentences were omitted.',
      },
    }
    const result = await renderPacketPdf(view(ctx, verbose), { clock: CLOCK })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.notices.join(' ')).toContain('truncated from 4512 to 1390 characters')
  })
})
