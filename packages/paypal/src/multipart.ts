/**
 * `multipart/form-data` for dispute evidence — spec §10.2 #14 and #16, [V3] [B16], EC-DSP-12.
 *
 * Three endpoints send evidence as multipart: `provide-evidence`, `appeal` and
 * `provide-supporting-info`. Each is a JSON `input` part plus zero or more file parts, and they
 * share every awkward part of that encoding, which is why it lives here once.
 *
 * ## The boundary is never written by hand
 *
 * `fetch` computes `Content-Type: multipart/form-data; boundary=…` from the `FormData` object it is
 * handed. If we also set the header ourselves with a guessed boundary, every part of the body becomes
 * unparseable at PayPal — and it fails as a 400 with no useful detail. So: build `FormData`, never
 * set `Content-Type` for these calls, and let the runtime do it. `client.multipart.test.ts` asserts
 * the header is absent from the `RequestInit` we pass *and* that a `Request` constructed from it
 * still carries a boundary.
 *
 * ## Local validation, before the bytes move (EC-DSP-12)
 *
 * PayPal's documented limits (https://developer.paypal.com/disputes/supported-file-sizes-types) are,
 * verbatim:
 *
 * > - **Supported file types**: `.jpg`, `.jpeg`, `.gif`, `.png`, and `.pdf`
 * > - **Individual file size**: Less than 10 MB per file
 * > - **Total file size**: Up to 50 MB per API call
 *
 * The five types are exactly what {@link ALLOWED_EVIDENCE_CONTENT_TYPES} encodes — verified. The two
 * byte counts are **decimal, not binary**, and deliberately so (report §12/#18/#30):
 *
 *  - The per-file limit is exclusive ("less than 10 MB") and `resolveFile` rejects at
 *    `size >= MAX_EVIDENCE_FILE_BYTES`, so an exactly-10 MB file is refused — which is what the
 *    wording says.
 *  - The total limit is inclusive ("up to 50 MB") and `buildEvidenceForm` rejects at
 *    `total > MAX_EVIDENCE_TOTAL_BYTES`.
 *
 * **Why decimal and not 2^20.** PayPal never says which "MB" means, and `SPEC-D` carries no size
 * constraint at all — no `maxLength` on `document.name`, no byte limits anywhere. The old
 * `50 * 1024 * 1024` was *more permissive* than the documented figure, so a 51 MB upload passed local
 * validation and came back as a remote rejection: the worst moment to learn a limit, after the
 * merchant's approval flow has been spent and with a live deadline (EC-DSP-12). Decimal is the
 * conservative reading — it fails locally, where the error can name the file.
 *
 * ASSUMPTION (report §30): the decimal reading is a conservative choice, **not** a documented fact.
 */
import { csError, ok, err } from '@countersign/core'
import type { CsError, Result } from '@countersign/core'

/**
 * Single-file ceiling, EC-DSP-12: PayPal's "less than 10 MB per file" as **10 MB decimal**. The check
 * is exclusive, so a file of exactly this size is already refused.
 */
export const MAX_EVIDENCE_FILE_BYTES = 10_000_000

/**
 * Whole-request ceiling: PayPal's "up to 50 MB per API call" as **50 MB decimal**. The check is
 * inclusive, so exactly 50 000 000 bytes is accepted.
 *
 * Was `50 * 1024 * 1024` (52 428 800), which is *looser* than PayPal's documented limit.
 */
export const MAX_EVIDENCE_TOTAL_BYTES = 50_000_000

/** The part name carrying the JSON evidence description [V3]. */
export const EVIDENCE_INPUT_FIELD = 'input'

/**
 * Filename we give the `input` part.
 *
 * PayPal's documented form is a **bare field**: the "Use Disputes API" guide and the "Test go live"
 * page both write `-F 'input={"evidences":[…]};type=application/json'`, with no `filename` in the
 * part's content-disposition. We send it as a named file part with an explicit `application/json`
 * type instead, which is a superset — same field name, same part name, same media type, plus
 * `filename="input.json"`.
 *
 * (The OpenAPI names the file part `evidence-file`, singular and hyphenated; that is a third spelling
 * and not what the guide's example uses. The guide is the better evidence for the *file* field names
 * `file1`, `file2`, …, which this package's default matches.)
 *
 * KEPT as-is, to be settled by the sandbox probe (report §23): `FormData` computes both the boundary
 * and the content-disposition, so the extra `filename` cannot corrupt the encoding. The open question
 * is only whether PayPal's parser minds it.
 */
export const EVIDENCE_INPUT_FILENAME = 'input.json'

/** Content types PayPal accepts for dispute evidence (EC-DSP-12). */
export const ALLOWED_EVIDENCE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
] as const

export type AllowedEvidenceContentType = (typeof ALLOWED_EVIDENCE_CONTENT_TYPES)[number]

/** Extensions we accept when a caller does not declare a content type. */
const EXTENSION_TO_CONTENT_TYPE: Readonly<Record<string, AllowedEvidenceContentType>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  pdf: 'application/pdf',
}

/** What a caller hands us for one evidence file. */
export interface EvidenceFile {
  /**
   * The multipart field name. Defaults to `file1`, `file2`, … in order, which is the shape of the
   * examples in [V3]. Field names other than `input` are accepted by PayPal's parser.
   */
  readonly fieldName?: string
  readonly fileName: string
  /** Declared type. Inferred from the extension when absent. */
  readonly contentType?: string
  readonly content: Uint8Array | ArrayBuffer | Blob | string
}

interface ResolvedFile {
  readonly fieldName: string
  readonly fileName: string
  readonly contentType: AllowedEvidenceContentType
  readonly blob: Blob
  readonly size: number
}

function isAllowedContentType(v: string): v is AllowedEvidenceContentType {
  return (ALLOWED_EVIDENCE_CONTENT_TYPES as readonly string[]).includes(v)
}

/**
 * Normalise a declared content type.
 *
 * `image/jpg` is what Windows tooling produces and PayPal documents `image/jpeg`; treating them as
 * different types would reject a file a human reasonably considers a jpg.
 */
function normaliseContentType(raw: string): string {
  const base = raw.trim().toLowerCase().split(';')[0] ?? ''
  return base === 'image/jpg' ? 'image/jpeg' : base
}

function contentTypeFromFileName(fileName: string): AllowedEvidenceContentType | undefined {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return undefined
  return EXTENSION_TO_CONTENT_TYPE[fileName.slice(dot + 1).toLowerCase()]
}

/**
 * Wrap file content in a `Blob` carrying `contentType`.
 *
 * The type has to be set here, not at the call site: a `Blob` built from a string or a `Uint8Array`
 * has `type === ''`, and an untyped part is how an image arrives at PayPal as an unrecognised
 * attachment.
 */
async function toBlob(
  content: EvidenceFile['content'],
  contentType: AllowedEvidenceContentType,
): Promise<Blob> {
  if (content instanceof Blob) return new Blob([content], { type: contentType })
  if (content instanceof Uint8Array) {
    // Copy into a fresh ArrayBuffer: a Uint8Array view may be a window onto a larger buffer, and
    // `new Blob([view])` would honour `byteOffset`/`byteLength` anyway — being explicit avoids the
    // surprise of a non-zero byteOffset.
    const copy = new Uint8Array(content.byteLength)
    copy.set(content)
    return new Blob([copy], { type: contentType })
  }
  return new Blob([content], { type: contentType })
}

/**
 * Validate one file against the EC-DSP-12 limits.
 *
 * @returns the file resolved to a `Blob` with a known type and a measured size, or the reason it is
 *   refused. The size is measured from the bytes, never declared by the caller.
 */
async function resolveFile(
  file: EvidenceFile,
  index: number,
  fieldName: string,
): Promise<Result<ResolvedFile, CsError>> {
  if (typeof file.fileName !== 'string' || file.fileName.trim() === '') {
    return err(csError('CS_VALIDATION', `Evidence file ${index + 1} has no fileName`, { index }))
  }

  const declared =
    file.contentType === undefined ? undefined : normaliseContentType(file.contentType)
  const inferred = contentTypeFromFileName(file.fileName)
  const contentType = declared ?? inferred
  if (contentType === undefined) {
    return err(
      csError(
        'CS_VALIDATION',
        `Evidence file "${file.fileName}" has no recognisable type. Pass contentType or use one of: ${ALLOWED_EVIDENCE_CONTENT_TYPES.join(', ')}`,
        { file_name: file.fileName, index, allowed: [...ALLOWED_EVIDENCE_CONTENT_TYPES] },
      ),
    )
  }
  if (!isAllowedContentType(contentType)) {
    return err(
      csError(
        'CS_VALIDATION',
        `Evidence file "${file.fileName}" is ${contentType}; PayPal accepts only ${ALLOWED_EVIDENCE_CONTENT_TYPES.join(', ')} (EC-DSP-12)`,
        {
          file_name: file.fileName,
          index,
          content_type: contentType,
          allowed: [...ALLOWED_EVIDENCE_CONTENT_TYPES],
        },
      ),
    )
  }

  let blob: Blob
  try {
    blob = await toBlob(file.content, contentType)
  } catch (e) {
    return err(
      csError(
        'CS_VALIDATION',
        `Evidence file "${file.fileName}" could not be read`,
        {
          file_name: file.fileName,
          index,
        },
        { cause: e },
      ),
    )
  }

  const size = blob.size
  if (size <= 0) {
    return err(
      csError('CS_VALIDATION', `Evidence file "${file.fileName}" is empty`, {
        file_name: file.fileName,
        index,
      }),
    )
  }
  if (size >= MAX_EVIDENCE_FILE_BYTES) {
    return err(
      csError(
        'CS_VALIDATION',
        `Evidence file "${file.fileName}" is ${size} bytes; the per-file limit is ` +
          `${MAX_EVIDENCE_FILE_BYTES} bytes (10 MB) and it must be smaller (EC-DSP-12)`,
        {
          file_name: file.fileName,
          index,
          size,
          max_bytes: MAX_EVIDENCE_FILE_BYTES,
        },
      ),
    )
  }

  return ok({ fieldName, fileName: file.fileName, contentType, blob, size })
}

/** Total bytes across the resolved files plus the JSON `input` part. */
export function totalEvidenceBytes(files: readonly ResolvedFile[], inputBytes: number): number {
  return files.reduce((sum, f) => sum + f.size, inputBytes)
}

/**
 * Build the `FormData` for an evidence upload.
 *
 * @param input the JSON evidence description — serialized into the `input` part.
 * @param files the evidence files, validated first.
 * @returns the `FormData`, or `CS_VALIDATION` naming the file that broke a limit. **No** request is
 *   attempted when this fails, which is the point of checking here.
 */
export async function buildEvidenceForm(
  input: unknown,
  files: readonly EvidenceFile[] = [],
): Promise<Result<FormData, CsError>> {
  const json = JSON.stringify(input ?? {})
  const inputBytes = new TextEncoder().encode(json).byteLength

  if (inputBytes > MAX_EVIDENCE_FILE_BYTES) {
    return err(
      csError(
        'CS_VALIDATION',
        `The evidence "input" part is ${inputBytes} bytes, over the ${MAX_EVIDENCE_FILE_BYTES}-byte limit`,
        {
          size: inputBytes,
          max_bytes: MAX_EVIDENCE_FILE_BYTES,
        },
      ),
    )
  }

  const resolved: ResolvedFile[] = []
  for (const [index, file] of files.entries()) {
    const fieldName = file.fieldName ?? `file${index + 1}`
    const r = await resolveFile(file, index, fieldName)
    if (!r.ok) return r
    resolved.push(r.value)
  }

  // Names must be unique: two files in one part would silently replace each other.
  const seen = new Set<string>()
  for (const f of resolved) {
    if (seen.has(f.fieldName)) {
      return err(
        csError(
          'CS_VALIDATION',
          `Duplicate multipart field name "${f.fieldName}" in one evidence upload`,
          {
            field_name: f.fieldName,
          },
        ),
      )
    }
    seen.add(f.fieldName)
  }

  const total = totalEvidenceBytes(resolved, inputBytes)
  if (total > MAX_EVIDENCE_TOTAL_BYTES) {
    return err(
      csError(
        'CS_VALIDATION',
        `Evidence upload is ${total} bytes; PayPal's limit is "up to 50 MB per API call" = ${MAX_EVIDENCE_TOTAL_BYTES} bytes (EC-DSP-12)`,
        { size: total, max_bytes: MAX_EVIDENCE_TOTAL_BYTES, files: resolved.length },
      ),
    )
  }

  const form = new FormData()
  // The `input` part is a real file part with an explicit JSON type, so the boundary and the
  // content-disposition come from the runtime along with everything else.
  form.append(
    EVIDENCE_INPUT_FIELD,
    new Blob([json], { type: 'application/json' }),
    EVIDENCE_INPUT_FILENAME,
  )
  for (const f of resolved) {
    form.append(f.fieldName, f.blob, f.fileName)
  }
  return ok(form)
}

/** The per-file sizes a caller would upload, for a pre-flight size display in the UI. */
export async function evidenceFileSizes(
  files: readonly EvidenceFile[],
): Promise<Result<{ fieldName: string; fileName: string; size: number }[], CsError>> {
  const out: { fieldName: string; fileName: string; size: number }[] = []
  for (const [index, file] of files.entries()) {
    const r = await resolveFile(file, index, file.fieldName ?? `file${index + 1}`)
    if (!r.ok) return r
    out.push({ fieldName: r.value.fieldName, fileName: r.value.fileName, size: r.value.size })
  }
  return ok(out)
}
