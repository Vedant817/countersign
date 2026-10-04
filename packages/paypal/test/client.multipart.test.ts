/**
 * Multipart evidence encoding — spec §10.2 #14 and #16, [V3], EC-DSP-12, AT-M6.6 (encoding half).
 *
 * The real upload needs a sandbox dispute, so AT-M6.6's *call* lives in `client.sandbox.test.ts`.
 * Everything here is testable without credentials, and everything here is what makes that call
 * correct when it finally runs:
 *
 *  - the `input` part is a JSON part named `input` carrying `{evidences: [ … ]}`, not a stray string;
 *  - `notes` inside each evidence entry is a **string** (PayPal types it `string`, 1–2000 chars) —
 *    the old `notes: string[]` would have been rejected;
 *  - `Content-Type` is **never** hand-written, so the runtime supplies the boundary;
 *  - an oversize or wrong-type file is refused locally with `CS_VALIDATION` and no HTTP call at all.
 */
import { describe, expect, it } from 'vitest'

import { createLogger } from '@countersign/core'

import { PayPalClient } from '../src/client'
import {
  EVIDENCE_INPUT_FIELD,
  EVIDENCE_INPUT_FILENAME,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
  buildEvidenceForm,
  evidenceFileSizes,
} from '../src/multipart'
import type { EvidenceFile } from '../src/multipart'
import { MAX_EVIDENCE_ITEMS, type ProvideEvidenceInput } from '../src/types'
import {
  capturingLogger,
  disputeResponse,
  fakeFetch,
  formParts,
  headerOf,
  linksResponse,
  onePagePdfBytes,
  partText,
  recordingSleep,
  testClock,
  tokenResponse,
} from './fixtures/transport-double'
import type { FakeResponseSpec, RecordedCall, Stub } from './fixtures/transport-double'

const BASE_URL = 'https://api-m.sandbox.paypal.com'
const DISPUTE_ID = 'PP-D-2781AB12CD34'
/** The documented `input` part: an `evidences` array whose `notes` is one string, not an array. */
const EVIDENCE_INPUT: ProvideEvidenceInput = {
  evidences: [
    {
      evidence_type: 'PROOF_OF_FULFILLMENT',
      notes: 'Shipped 1 Oct via UPS, tracking 1Z999AA10123456784.',
      evidence_info: {
        tracking_info: [{ carrier_name: 'UPS', tracking_number: '1Z999AA10123456784' }],
      },
    },
  ],
}

function makeClient(responder: Stub) {
  const fetchImpl = fakeFetch(responder)
  const client = new PayPalClient({
    baseUrl: BASE_URL,
    clientId: 'AY_FAKE_SANDBOX_CLIENT_ID_00000000',
    clientSecret: 'EL_FAKE_SANDBOX_SECRET_00000000',
    clock: testClock(),
    fetchImpl,
    sleep: recordingSleep().sleep,
    logger: createLogger({ level: 'error', sink: capturingLogger().sink }),
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: BASE_URL },
  })
  return { client, fetchImpl }
}

const isToken = (c: RecordedCall) => c.url.endsWith('/v1/oauth2/token')
const callTo = (calls: readonly RecordedCall[], fragment: string) =>
  calls.find((c) => c.url.includes(fragment)) as RecordedCall

/**
 * Anything that is not the token: a dispute carrying the `appeal` HATEOAS link for an `appeal` call,
 * and the links envelope for every other dispute action. `appeal` now re-reads the dispute first
 * (report §9/#17), so the responder has to answer that `GET` too.
 */
const disputeOrLinks = (call: RecordedCall): FakeResponseSpec => {
  if (isToken(call)) return tokenResponse()
  return call.method === 'GET' ? disputeResponse() : linksResponse()
}

const pdfFile = (bytes = onePagePdfBytes(), fileName = 'evidence-packet.pdf'): EvidenceFile => ({
  fileName,
  contentType: 'application/pdf',
  content: bytes,
})

describe('buildEvidenceForm', () => {
  it('puts the JSON evidence description in an `input` part typed application/json', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [])
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const form = built.value
    const input = form.get(EVIDENCE_INPUT_FIELD)
    expect(input).toBeInstanceOf(Blob)
    expect((input as Blob).type).toBe('application/json')
    expect(JSON.parse(await (input as Blob).text())).toEqual(EVIDENCE_INPUT)
  })

  it('names the input part so PayPal recognises it', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [pdfFile()])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const parts = [...built.value.entries()]
    expect(parts.some(([, v]) => v instanceof File && v.name === EVIDENCE_INPUT_FILENAME)).toBe(
      true,
    )
  })

  it('serialises the `input` part as {evidences:[…]}, the documented shape', async () => {
    // Report §2/#3: the part is an ARRAY wrapped in `evidences`, and each entry's `notes` is a
    // single string. Both of the old assumptions (a bare object, `notes: string[]`) are rejected by
    // PayPal, so this asserts the exact JSON that goes on the wire.
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const input = built.value.get(EVIDENCE_INPUT_FIELD) as Blob
    const wire = JSON.parse(await input.text()) as Record<string, unknown> & {
      evidences: { notes?: unknown }[]
    }
    expect(Array.isArray(wire.evidences)).toBe(true)
    expect(typeof wire.evidences[0]?.notes).toBe('string')
    expect(wire['evidence_type']).toBeUndefined()
  })

  it('refuses more than the 100 evidence items PayPal caps `evidence_list` at', async () => {
    // Report §2/#4. Locally refused, so an oversized batch costs no upload at all.
    const tooMany = {
      evidences: Array.from({ length: MAX_EVIDENCE_ITEMS + 1 }, () => ({
        evidence_type: 'PROOF_OF_FULFILLMENT',
      })),
    }
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.provideEvidence(DISPUTE_ID, tooMany, [])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('defaults file field names to file1, file2, … and allows an override', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [
      pdfFile(),
      pdfFile(onePagePdfBytes(), 'b.pdf'),
    ])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect([...built.value.keys()]).toEqual([EVIDENCE_INPUT_FIELD, 'file1', 'file2'])

    const named = await buildEvidenceForm(EVIDENCE_INPUT, [
      { ...pdfFile(), fieldName: 'tracking' },
      { ...pdfFile(onePagePdfBytes(), 'b.png'), fieldName: 'signed_readback' },
    ])
    expect(named.ok).toBe(true)
    if (!named.ok) return
    expect([...named.value.keys()]).toEqual([EVIDENCE_INPUT_FIELD, 'tracking', 'signed_readback'])
  })

  it('refuses two files that would silently replace each other in one part', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [
      { ...pdfFile(), fieldName: 'evidence' },
      { ...pdfFile(onePagePdfBytes(), 'b.pdf'), fieldName: 'evidence' },
    ])
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('CS_VALIDATION')
    expect(built.error.message).toContain('Duplicate multipart field name')
  })

  it('keeps the uploaded bytes intact', async () => {
    const bytes = onePagePdfBytes()
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [pdfFile(bytes)])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const part = built.value.get('file1')
    expect(part).toBeInstanceOf(Blob)
    const readBack = new Uint8Array(await (part as Blob).arrayBuffer())
    expect(Array.from(readBack)).toEqual(Array.from(bytes))
  })

  it('accepts a Blob, a Uint8Array, an ArrayBuffer and a string as file content', async () => {
    const bytes = onePagePdfBytes()
    const content: EvidenceFile['content'][] = [
      new Blob([bytes], { type: 'application/pdf' }),
      bytes,
      new Uint8Array(bytes).buffer,
      'plain bytes',
    ]
    for (const source of content) {
      const built = await buildEvidenceForm(EVIDENCE_INPUT, [
        { fileName: 'x.pdf', contentType: 'application/pdf', content: source },
      ])
      expect(built.ok).toBe(true)
    }
  })

  it('handles a Uint8Array that is a window onto a larger buffer', async () => {
    // `new Blob([view])` respects byteOffset/byteLength, so the bytes must be exactly the file's.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    const view = backing.subarray(2, 5)
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [
      { fileName: 'x.pdf', contentType: 'application/pdf', content: view },
    ])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const part = built.value.get('file1') as Blob
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('EC-DSP-12: local limits, before a single byte is uploaded', () => {
  it('refuses a file at or over the per-file limit, naming the file', async () => {
    const tooBig = new Uint8Array(MAX_EVIDENCE_FILE_BYTES)
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [pdfFile(tooBig)])
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('CS_VALIDATION')
    expect(built.error.details?.['file_name']).toBe('evidence-packet.pdf')
    expect(built.error.details?.['max_bytes']).toBe(MAX_EVIDENCE_FILE_BYTES)
    expect(built.error.message).toContain('EC-DSP-12')
  })

  it('accepts a file just under the limit', async () => {
    const justUnder = new Uint8Array(MAX_EVIDENCE_FILE_BYTES - 1)
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [pdfFile(justUnder)])
    expect(built.ok).toBe(true)
  })

  it("refuses a total over PayPal's 50 MB, using the decimal reading", async () => {
    // Report §12/#18: the cap was 50 * 1024 * 1024 = 52 428 800, which is *looser* than PayPal's
    // "up to 50 MB per API call", so a 51 MB upload passed locally and was rejected remotely.
    expect(MAX_EVIDENCE_TOTAL_BYTES).toBe(50_000_000)
    expect(MAX_EVIDENCE_FILE_BYTES).toBe(10_000_000)

    // Six 9 MB files: each is legal on its own, together they are not one request.
    const chunk = new Uint8Array(9 * 1000 * 1000)
    const files = Array.from({ length: 6 }, (_v, i) => pdfFile(chunk, `part-${i}.pdf`))
    const built = await buildEvidenceForm(EVIDENCE_INPUT, files)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('CS_VALIDATION')
    expect(built.error.details?.['max_bytes']).toBe(50_000_000)
    expect(built.error.message).toContain('50 MB')
  })

  it("rejects 50 000 001 bytes — one byte over PayPal's limit — locally with CS_VALIDATION", async () => {
    // The precise regression: 50 000 001 bytes used to pass local validation (it is below the old
    // 52 428 800 ceiling) and only fail at PayPal. Five files of 9 999 999 plus one of 6 bytes is
    // exactly 50 000 001.
    const big = new Uint8Array(9_999_999)
    const files = [
      ...Array.from({ length: 5 }, (_v, i) => pdfFile(big, `part-${i}.pdf`)),
      pdfFile(new Uint8Array(6), 'last.pdf'),
    ]
    const bytes = files.reduce((sum, f) => sum + (f.content as Uint8Array).byteLength, 0)
    expect(bytes).toBe(50_000_001)

    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, files)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(result.error.details?.['size']).toBeGreaterThan(MAX_EVIDENCE_TOTAL_BYTES)
    expect(result.error.details?.['max_bytes']).toBe(MAX_EVIDENCE_TOTAL_BYTES)
    // Refused before any HTTP call — the whole point of checking here.
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('accepts exactly 50 000 000 bytes, because PayPal says "up to 50 MB"', async () => {
    // `buildEvidenceForm` counts the `input` part in the total, so the files are sized to land the
    // whole request on exactly the documented limit: 5 × 9 999 999 + 3 = 49 999 998, plus the 2 bytes
    // of the `{}` input part.
    const big = new Uint8Array(9_999_999)
    const files = [
      ...Array.from({ length: 5 }, (_v, i) => pdfFile(big, `part-${i}.pdf`)),
      pdfFile(new Uint8Array(3), 'last.pdf'),
    ]
    const built = await buildEvidenceForm({}, files)
    expect(built.ok).toBe(true)
  })

  it('refuses an empty file', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [pdfFile(new Uint8Array(0))])
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.message).toContain('empty')
  })

  it('refuses a content type PayPal does not accept for evidence', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [
      {
        fileName: 'notes.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: 'x',
      },
    ])
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.code).toBe('CS_VALIDATION')
    expect(built.error.message).toContain('EC-DSP-12')
  })

  it('accepts jpg, png, gif and pdf, inferring the type from the extension', async () => {
    for (const [fileName, expected] of [
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.png', 'image/png'],
      ['a.gif', 'image/gif'],
      ['a.pdf', 'application/pdf'],
    ] as const) {
      const built = await buildEvidenceForm(EVIDENCE_INPUT, [{ fileName, content: 'x' }])
      expect(built.ok, `${fileName} should be accepted`).toBe(true)
      if (!built.ok) continue
      const part = built.value.get('file1') as Blob
      expect(part.type).toBe(expected)
    }
  })

  it('treats image/jpg as image/jpeg, because that is what Windows tooling emits', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [
      { fileName: 'photo.jpg', contentType: 'image/jpg', content: 'x' },
    ])
    expect(built.ok).toBe(true)
  })

  it('refuses a file with no recognisable type at all', async () => {
    const built = await buildEvidenceForm(EVIDENCE_INPUT, [{ fileName: 'evidence', content: 'x' }])
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.error.message).toContain('no recognisable type')
  })

  it('measures sizes from the bytes, not from what the caller claims', async () => {
    const built = await evidenceFileSizes([pdfFile(onePagePdfBytes())])
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value[0]).toEqual({
      fieldName: 'file1',
      fileName: 'evidence-packet.pdf',
      size: onePagePdfBytes().byteLength,
    })
  })
})

describe('the boundary is never hand-written', () => {
  it('sends no Content-Type header on a multipart call', async () => {
    // Hand-writing `multipart/form-data; boundary=…` with a guessed boundary makes every part
    // unparseable at PayPal, and the failure is a bare 400 with no detail.
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    const result = await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()])
    expect(result.ok).toBe(true)

    const call = callTo(fetchImpl.calls, '/provide-evidence')
    expect(headerOf(call, 'content-type')).toBeUndefined()
    expect(call.body).toBeInstanceOf(FormData)
  })

  it('the runtime still produces a content type with a boundary from what we passed', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()])
    const call = callTo(fetchImpl.calls, '/provide-evidence')

    // Reconstruct a Request the way `fetch` would and read the header it derives.
    const request = new Request('https://api-m.sandbox.paypal.com/x', {
      method: 'POST',
      body: call.body as FormData,
    })
    const contentType = request.headers.get('content-type') ?? ''
    expect(contentType).toMatch(/^multipart\/form-data;\s*boundary=/)
    expect(contentType).not.toBe('multipart/form-data')
  })

  it('does hand-write Content-Type for JSON bodies, where there is no boundary to compute', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    await client.sendMessage(DISPUTE_ID, 'hello')
    expect(headerOf(callTo(fetchImpl.calls, '/send-message'), 'content-type')).toBe(
      'application/json',
    )
  })
})

describe('provideEvidence, appeal and provideSupportingInfo share the encoder', () => {
  it('each builds the same input part and never a boundary', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)

    await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()], {
      requestId: 'cs:dsp_1:file:1',
    })
    await client.appeal(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()], { requestId: 'cs:dsp_1:appeal:1' })
    await client.provideSupportingInfo(DISPUTE_ID, 'Carrier scan attached.', [pdfFile()])

    for (const fragment of ['/provide-evidence', '/appeal', '/provide-supporting-info']) {
      const call = callTo(fetchImpl.calls, fragment)
      expect(call, `no call for ${fragment}`).toBeDefined()
      expect(headerOf(call, 'content-type')).toBeUndefined()
      const parts = formParts(call)
      expect(parts.map((p) => p.name)).toContain(EVIDENCE_INPUT_FIELD)
      expect(parts.map((p) => p.name)).toContain('file1')
    }
  })

  it('carries the §8.15 filing key so a retried filing is deduplicated', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()], {
      requestId: 'cs:dsp_1:file:1',
    })
    expect(headerOf(callTo(fetchImpl.calls, '/provide-evidence'), 'paypal-request-id')).toBe(
      'cs:dsp_1:file:1',
    )
  })

  it('a rejected oversize file never reaches the network', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    const result = await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [
      pdfFile(new Uint8Array(MAX_EVIDENCE_FILE_BYTES)),
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    // Not even the token request: the limit is checked before anything leaves the process.
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('an oversize file also stops an appeal and a supporting-info upload', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const oversize = [pdfFile(new Uint8Array(MAX_EVIDENCE_FILE_BYTES + 1))]
    expect((await client.appeal(DISPUTE_ID, EVIDENCE_INPUT, oversize)).ok).toBe(false)
    expect((await client.provideSupportingInfo(DISPUTE_ID, 'notes', oversize)).ok).toBe(false)
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses an evidence input with no evidence_type', async () => {
    const { client, fetchImpl } = makeClient(tokenResponse())
    const result = await client.provideEvidence(
      DISPUTE_ID,
      // @ts-expect-error evidence_type is required per evidence entry; omitting it must fail locally.
      { evidences: [{ notes: 'no type' }] },
      [],
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('CS_VALIDATION')
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('serialises the input part exactly once, with no stray JSON string field', async () => {
    const { client, fetchImpl } = makeClient(disputeOrLinks)
    await client.provideEvidence(DISPUTE_ID, EVIDENCE_INPUT, [pdfFile()])
    const parts = formParts(callTo(fetchImpl.calls, '/provide-evidence'))
    const inputParts = parts.filter((p) => p.name === EVIDENCE_INPUT_FIELD)
    expect(inputParts).toHaveLength(1)
    const text = await partText(inputParts[0]!.value)
    expect(JSON.parse(text)).toEqual(EVIDENCE_INPUT)
  })
})
