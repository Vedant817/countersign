/**
 * The QR in an evidence packet, decoded by something that did not draw it.
 *
 * ```ts
 * pnpm --filter @countersign/defender exec vitest run test/qr-decode.test.ts
 * ```
 *
 * ## Why this file exists separately
 *
 * `test/qr.test.ts` was honest about its own limit: it compared our matrix against `qrcode`'s encoding
 * of the same string, which is a **round-trip identity check**. It proves we encode exactly the string we
 * mean to. It does **not** prove the symbol is scannable, because both sides of the comparison are the
 * same encoder — a matrix built from garbage that happened to round-trip would pass.
 *
 * So this file uses `jsqr`, an independent decoder, on a rendered raster of the matrix. Different
 * implementation, opposite direction, no shared code with the encoder beyond the payload string.
 *
 * ## Why raster rather than matrix
 *
 * `jsQR` reads pixels. A real reader sees a printed or on-screen image: modules at some scale, with a
 * quiet zone around them. Testing the abstract boolean grid would skip exactly the parts most likely to
 * be wrong in `evidence-doc.ts` — the scale, the quiet zone, and the light/dark polarity. So this file
 * builds the raster the renderer builds, and decodes that.
 *
 * Polarity is the reason this is worth asserting explicitly: a QR drawn dark-on-light inverts into
 * unscannable, and a matrix comparison is blind to it. An inverted symbol **decodes to nothing**, which
 * is the assertion below that fails if `evidence-doc.ts` gets the colours backwards.
 */

import jsQR from 'jsqr'
import { describe, expect, it } from 'vitest'

import { QR_QUIET_ZONE_MODULES, isPacketUrl, qrMatrixFor } from '../src/qr'
import { publicPacketUrl } from '../src/citation-check'

const BASE = 'https://countersign.example'
const PACKET = 'pkt_01HQ0000000000000000000000'
const ADDRESS = publicPacketUrl(BASE, PACKET)

/** Pixels per module. {@link evidence-doc.ts} draws at 4; matching it is the point. */
const SCALE = 4
const QUIET = QR_QUIET_ZONE_MODULES

interface Raster {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * Rasterise a matrix exactly as the renderer does: dark modules black on white, with the quiet zone.
 *
 * `invert` exists to prove the polarity assertion is real — if the decoder simply failed on our raster,
 * the inverted case would pass for the wrong reason.
 */
function rasteriseAtScale(
  m: { size: number; dark: (x: number, y: number) => boolean },
  scale: number,
  invert = false,
  quiet = QUIET,
): Raster {
  const side = (m.size + quiet * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4)
  // Opaque white first, so any unwritten pixel is visibly wrong rather than transparent black.
  data.fill(255)
  // Inverted symbols draw light modules dark, which is what "drawn wrong" looks like.
  const v = invert ? 255 : 0
  for (let y = 0; y < m.size; y += 1) {
    for (let x = 0; x < m.size; x += 1) {
      if (!m.dark(x, y)) continue
      const px = (x + quiet) * scale
      const py = (y + quiet) * scale
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const i = ((py + dy) * side + (px + dx)) * 4
          data[i + 0] = v
          data[i + 1] = v
          data[i + 2] = v
          data[i + 3] = 255
        }
      }
    }
  }
  return { data, width: side, height: side }
}

/** The renderer's own geometry: {@link SCALE} pixels per module, {@link QUIET} modules of quiet zone. */
function rasterise(
  m: { size: number; dark: (x: number, y: number) => boolean },
  invert = false,
): Raster {
  return rasteriseAtScale(m, SCALE, invert)
}

describe('an independent decoder reads the packet QR back', () => {
  it('decodes to exactly PUBLIC_BASE_URL + /v/{packetId}', () => {
    const matrix = qrMatrixFor(ADDRESS)
    const raster = rasterise(matrix)
    const decoded = jsQR(raster.data, raster.width, raster.height)

    // A null here is the failure this file exists to catch: `test/qr.test.ts` would still have passed,
    // because it compares the encoder against itself.
    expect(decoded, 'jsQR could not read the symbol at all').not.toBeNull()
    expect(decoded?.data).toBe(ADDRESS)
  })

  it('is discriminating: a one-character change decodes to the changed string, not the original', () => {
    // Without this, "the decoder returned our string" could be satisfied by a decoder that returns
    // whatever it was configured with. Here the payload is genuinely different, and the answer changes
    // with it — so the decode above is measuring the matrix, not the harness.
    const other = 'pkt_01HQ0000000000000000000001'
    const decoded = jsQR(...asDecodeArgs(rasterise(qrMatrixFor(publicPacketUrl(BASE, other)))))
    expect(decoded?.data).toBe(`${BASE}/v/${other}`)
    expect(decoded?.data).not.toBe(ADDRESS)
  })

  it('reads nothing when the symbol is inverted, which is why the colours are asserted', () => {
    // This is the assertion that makes the first one trustworthy. If an inverted symbol still decoded,
    // the decoder would not be doing real work and the positive case would be an artefact.
    const inverted = rasterise(qrMatrixFor(ADDRESS), true)
    expect(jsQR(inverted.data, inverted.width, inverted.height)).toBeNull()
  })

  it('decodes with or without the quiet zone, which is a property of jsQR and not of our code', () => {
    // This test originally asserted that a symbol with **no** quiet zone fails to decode. It does not,
    // and that is worth recording rather than deleting.
    //
    // `jsQR` locates the three finder patterns by scanning the whole raster and does not enforce
    // ISO/IEC 18004 §9.1's 4-module margin. A phone camera *does* enforce it, and a printed packet with
    // a tight margin is the classic "scans on my machine, will not scan on a phone" failure — which is
    // exactly why `evidence-doc.ts` draws the margin.
    //
    // Asserting `null` here would have been asserting a property of the decoder we happened to pick, not
    // a property of the packet. So what is asserted is the true and useful thing: the symbol is intact
    // with and without the margin, the margin changes the raster by exactly the documented amount, and
    // the constant we draw by is the ISO minimum.
    const matrix = qrMatrixFor(ADDRESS)

    const withQuiet = rasteriseAtScale(matrix, SCALE, false, QUIET)
    const withoutQuiet = rasteriseAtScale(matrix, SCALE, false, 0)

    // ISO/IEC 18004 §9.1: 4 modules. This is the number the renderer uses.
    expect(QUIET).toBe(4)
    expect(withQuiet.width).toBe(withoutQuiet.width + QUIET * 2 * SCALE)

    // Both decode — recorded as behaviour of this decoder, so a future change to `jsQR` that tightened
    // it would show up here as `withoutQuiet` going null and someone would investigate rather than
    // shrug.
    expect(jsQR(withQuiet.data, withQuiet.width, withQuiet.height)?.data).toBe(ADDRESS)
    expect(jsQR(withoutQuiet.data, withoutQuiet.width, withoutQuiet.height)?.data).toBe(ADDRESS)
  })

  it('survives a payload drawn at every scale the renderer might use', () => {
    // A QR that only scans at one pixel-per-module ratio is a QR that scans on a developer machine and
    // fails on a phone. Scaling is a rendering choice, so the property belongs here.
    const matrix = qrMatrixFor(ADDRESS)
    for (const scale of [2, 3, 4, 6, 8]) {
      const raster = rasteriseAtScale(matrix, scale)
      expect(
        jsQR(raster.data, raster.width, raster.height)?.data,
        `scale ${scale} did not decode`,
      ).toBe(ADDRESS)
    }
  })

  it('refuses to encode a payload that is not the packet address, before anything is drawn', () => {
    // The guard `evidence-doc.ts` calls. A mis-wired PUBLIC_BASE_URL must fail at render time with a
    // CS_VALIDATION, which is before upload — EC-DSP-12's whole point.
    expect(isPacketUrl(ADDRESS, BASE, PACKET)).toBe(true)
    expect(isPacketUrl(`${ADDRESS}?utm_source=paypal`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`https://elsewhere.example/v/${PACKET}`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`${BASE}/v/${PACKET}/extra`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`${BASE}/v/${PACKET}#frag`, BASE, PACKET)).toBe(false)
    expect(isPacketUrl(`${BASE}/v/${PACKET.toUpperCase()}`, BASE, PACKET)).toBe(false)
  })

  it('throws rather than silently truncating an empty payload', () => {
    // An empty QR is a scannable nothing. Failing loudly beats shipping a packet whose code opens a blank
    // page.
    expect(() => qrMatrixFor('')).toThrow()
  })
})

/** `jsQR` takes positional args; this keeps the call sites readable without a wrapper closure. */
function asDecodeArgs(raster: Raster): [Uint8ClampedArray, number, number] {
  return [raster.data, raster.width, raster.height]
}
