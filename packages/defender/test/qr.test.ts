/**
 * The QR and its payload — spec **§8.18** ("Live re-verification"), **AT-M15.3** ("embeds the QR to
 * `/v/{packet}`"), work package **WP-15d**.
 *
 * ## Why these tests are so specific about "the payload is the address and nothing else"
 *
 * A QR is a **redirect**. Whoever controls the string controls where a scan goes, and a reader scans
 * *because they trust the document*. So the payload is not a formatting detail: it is the one part of the
 * packet a third party acts on. §8.15 permits exactly one link in the whole document, and the QR had better
 * be that one.
 *
 * Three assertions, because one is not enough:
 *
 * 1. **The payload equals `PUBLIC_BASE_URL` + `/v/{packetId}`.** Necessary, and vacuous on its own.
 * 2. **The drawn matrix is bit-identical to the library's encoding of that payload**, so nothing else was
 *    drawn into it and no second payload is hiding in the padding.
 * 3. **Changing one character of the payload changes the matrix.** This is what makes (1) and (2)
 *    discriminating. Without it, a matrix that ignored its input entirely would pass the first two.
 *
 * The honest limit, stated because it is a limit: this is a **round-trip identity check**, not an
 * independent QR decoder. `qrcode` is the only encoder available offline, and re-encoding with it proves
 * consistency rather than the correctness of the symbol format. The format correctness comes from the
 * library; what these tests establish is that **we encode exactly the string we mean to**, and that a
 * reviewer can rely on that.
 */

import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'

import { publicPacketUrl } from '../src/citation-check'
import {
  QR_ERROR_CORRECTION,
  QR_QUIET_ZONE_MODULES,
  expectedPayload,
  isPacketUrl,
  qrMatrixFor,
} from '../src/qr'

const BASE = 'https://countersign.example'
const PACKET = 'pkt_01HQ0000000000000000000000'
const ADDRESS = publicPacketUrl(BASE, PACKET)

/** Every module as one flat bit string, so two matrices can be compared without nesting loops. */
function bits(m: { size: number; dark: (x: number, y: number) => boolean }): string {
  let out = ''
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) out += m.dark(x, y) ? '1' : '0'
  }
  return out
}

describe('the public verifier address', () => {
  it('is PUBLIC_BASE_URL + /v/{packetId}, and nothing else', () => {
    expect(ADDRESS).toBe(`${BASE}/v/${PACKET}`)
    expect(expectedPayload(BASE, PACKET)).toBe(publicPacketUrl(BASE, PACKET))
  })

  it('carries no query string, no fragment and no second path segment', () => {
    // A tracking parameter on a QR is a redirect we do not control. §8.15 permits one link; it is this one.
    const parsed = new globalThis.URL(ADDRESS)
    expect(parsed.search).toBe('')
    expect(parsed.hash).toBe('')
    expect(parsed.pathname).toBe(`/v/${PACKET}`)
    expect(parsed.pathname.split('/').filter((s) => s.length > 0)).toHaveLength(2)
  })

  it('strips a trailing slash from the base, because PUBLIC_BASE_URL is operator-configured', () => {
    // Both spellings occur in deployment config and only one of them is a real URL. A trailing slash would
    // produce `//v/…`: a different string from the one `checkCitations` was configured with (so a correct
    // note would be refused as a disallowed URL) *and* a 404.
    expect(publicPacketUrl(`${BASE}/`, PACKET)).toBe(ADDRESS)
    expect(publicPacketUrl(`${BASE}///`, PACKET)).toBe(ADDRESS)
    expect(publicPacketUrl(`  ${BASE}  `, PACKET)).toBe(ADDRESS)
  })

  it('agrees with itself across every spelling of the same base', () => {
    for (const base of [BASE, `${BASE}/`, `${BASE}//`]) {
      expect(isPacketUrl(publicPacketUrl(base, PACKET), BASE, PACKET), base).toBe(true)
    }
  })

  it('says no to a payload that is not this packet’s address', () => {
    // The guard `evidence-doc.ts` calls before it draws.
    expect(isPacketUrl(ADDRESS, BASE, 'pkt_someoneelse')).toBe(false)
    expect(isPacketUrl(`${ADDRESS}?utm_source=paypal`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`${ADDRESS}#top`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`https://evil.example/v/${PACKET}`, BASE, PACKET)).toBe(false)
  })
})

describe('the QR symbol', () => {
  const matrix = qrMatrixFor(ADDRESS)

  it('encodes exactly the public address, with no query and no fragment', () => {
    expect(bits(matrix)).toBe(bits(qrMatrixFor(ADDRESS)))
    expect(ADDRESS).not.toContain('?')
    expect(ADDRESS).not.toContain('#')
  })

  it('is drawn bit-for-bit as the library encodes the payload, so nothing else is in it', () => {
    // This is the assertion that would catch a second payload hidden in the quiet zone, or a QR built from
    // a template with the address pasted in afterwards.
    const reference = QRCode.create(ADDRESS, { errorCorrectionLevel: QR_ERROR_CORRECTION })
    expect(matrix.size).toBe(reference.modules.size)
    for (let y = 0; y < matrix.size; y += 1) {
      for (let x = 0; x < matrix.size; x += 1) {
        expect(matrix.dark(x, y), `module ${x},${y}`).toBe(reference.modules.get(y, x) === 1)
      }
    }
  })

  it('changes when a single character of the payload changes', () => {
    // Without this, the two assertions above would also pass for a matrix that ignored its input.
    const near = ADDRESS.replace(/pkt_(.)/, 'pkt_X')
    expect(near).not.toBe(ADDRESS)
    expect(bits(qrMatrixFor(near))).not.toBe(bits(matrix))
  })

  it('changes when only the host changes, so a swapped PUBLIC_BASE_URL cannot reuse a symbol', () => {
    expect(bits(qrMatrixFor(publicPacketUrl('https://evil.example', PACKET)))).not.toBe(
      bits(matrix),
    )
  })

  it('is a valid symbol size, with the three finder patterns where they belong', () => {
    // 21..177 per ISO/IEC 18004, always odd. A truncated or padded matrix still scans on a good phone,
    // which is the failure mode a size-and-finder assertion catches and a "does it decode" test does not.
    expect(matrix.size % 2).toBe(1)
    expect(matrix.size).toBeGreaterThanOrEqual(21)
    expect(matrix.size).toBeLessThanOrEqual(177)
    const corners: readonly (readonly [number, number])[] = [
      [0, 0],
      [matrix.size - 7, 0],
      [0, matrix.size - 7],
    ]
    for (const [ox, oy] of corners) {
      expect(matrix.dark(ox, oy)).toBe(true)
      expect(matrix.dark(ox + 3, oy + 3)).toBe(true)
      expect(matrix.dark(ox + 1, oy + 1)).toBe(false)
      expect(matrix.dark(ox + 2, oy)).toBe(true)
    }
  })

  it('has the documented error-correction level and a quiet zone a phone camera will tolerate', () => {
    expect(QR_ERROR_CORRECTION).toBe('M')
    // ISO/IEC 18004 §9.1: four modules of quiet zone. A code with none is unscannable on a printed page.
    expect(QR_QUIET_ZONE_MODULES).toBe(4)
  })

  it('is immutable, so a caller cannot corrupt a matrix another section is drawing', () => {
    const m = qrMatrixFor(ADDRESS)
    const row = m.modules[0]
    expect(row).toBeDefined()
    expect(Object.isFrozen(m.modules)).toBe(true)
    expect(Object.isFrozen(row)).toBe(true)
    // The accessor is total: outside the grid it is false — the quiet zone — and never a throw.
    expect(m.dark(-1, -1)).toBe(false)
    expect(m.dark(9999, 9999)).toBe(false)
  })

  it('refuses to encode an empty payload rather than drawing a symbol that scans to nothing', () => {
    expect(() => qrMatrixFor('')).toThrow(/empty payload/)
  })

  it('grows for a longer address, and stays inside the maximum symbol size', () => {
    // The size must be a function of the payload, not a constant: a fixed-size symbol for a variable
    // address is how a truncated payload ships.
    const short = qrMatrixFor('https://a.example/v/pkt_x')
    const long = qrMatrixFor(`${ADDRESS}${'a'.repeat(600)}`)
    expect(long.size).toBeGreaterThan(short.size)
    expect(long.size).toBeLessThanOrEqual(177)
  })
})

describe('the QR and the printed address cannot disagree', () => {
  it('encodes and prints the same string, so a reader can compare them with their eyes', () => {
    // The caption is a human-readable copy and the QR is the machine-readable one. If they disagreed, the
    // document would be asking a reader to trust one of them, which is the opposite of the point.
    expect(expectedPayload(BASE, PACKET)).toBe(ADDRESS)
    expect(ADDRESS.startsWith(BASE)).toBe(true)
    expect(ADDRESS.split('/').pop()).toBe(PACKET)
  })

  it('gives a different packet a different symbol, so one code cannot be reused across packets', () => {
    const a = bits(qrMatrixFor(publicPacketUrl(BASE, 'pkt_aaaaaaaaaaaaaaaaaaaaaaaaaa')))
    const b = bits(qrMatrixFor(publicPacketUrl(BASE, 'pkt_bbbbbbbbbbbbbbbbbbbbbbbbbb')))
    expect(a).not.toBe(b)
  })
})
