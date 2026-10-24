/**
 * The subject-access export — EC-PRIV-2, spec §8.19 ("Export: a JSON zip of everything for the user").
 *
 * §12.13 gives the export two properties that shape this file: it is returned **within 24 h**
 * (immediately in the demo), and it contains the user's own data — which is a different set from the
 * data an *operator* can see. That second point is the one worth writing code for: an export is the
 * easiest place in a system to leak another person's data, because it is assembled by walking tables
 * that are normally queried one row at a time.
 *
 * Two rules make that safe, and both are enforced here rather than at the call site:
 *
 *  1. **Every section is fetched by subject.** The port below takes a `userId` and there is no method
 *     that returns a table. A new section cannot be added without saying whose rows it returns.
 *  2. **Sections that can contain another person's data are redacted, not copied.** `redactSection`
 *     runs the repo-wide PII scrubber over every string, so a merchant's name inside a dispute note,
 *     or a second buyer's email inside a webhook payload, is masked even though the row belongs to
 *     the requester. The verifier already does this for its public bundle; an export is the same
 *     problem with a friendlier interface.
 *
 * The bundle is a value object, not a zip file: turning it into bytes is the delivery layer's job,
 * and keeping it a plain object is what makes the acceptance test readable.
 */
import {
  csError,
  err,
  ok,
  redact,
  redactText,
  scrubPii,
  type CsError,
  type Result,
} from '@countersign/core'

/** One named file in the bundle. */
export interface ExportFile {
  readonly name: string
  readonly content: unknown
  /** Rows included, for the manifest. `null` for a document rather than a list. */
  readonly count: number | null
}

export interface ExportBundle {
  readonly userId: string
  readonly generatedAtSec: number
  readonly files: readonly ExportFile[]
  readonly manifest: {
    readonly sections: readonly string[]
    readonly totalRows: number
    readonly redaction: string
    readonly retention: string
  }
}

/**
 * The reads an export needs, each scoped to one subject.
 *
 * A production adapter is a thin wrapper over `@countersign/db`; the test double is a literal object.
 * Both are small because the shape is deliberately the narrowest set of reads that §12.13's export
 * row requires.
 */
export interface PrivacyExportStore {
  readonly user: (userId: string) => Promise<unknown | null>
  readonly wallets: (userId: string) => Promise<readonly unknown[]>
  readonly mandates: (userId: string) => Promise<readonly unknown[]>
  readonly orders: (userId: string) => Promise<readonly unknown[]>
  readonly disputes: (userId: string) => Promise<readonly unknown[]>
  readonly evidencePackets: (userId: string) => Promise<readonly unknown[]>
  readonly privacyRequests: (userId: string) => Promise<readonly unknown[]>
}

/** The redaction note that goes in every manifest, so the recipient knows what was removed. */
export const EXPORT_REDACTION_NOTE =
  'Free text is scrubbed for emails, card numbers and phone numbers, and credential-shaped values are replaced. Names of other people involved in a case are not exported.'

export const EXPORT_RETENTION_NOTE =
  'This bundle contains only rows still inside their retention window (spec §12.13). Rows already purged are absent by design.'

/**
 * Scrub one section, recursively.
 *
 * Two passes, for the same reason `createLogger` has two: `redact` catches **key-shaped** mistakes
 * (a `payer_email` field, a `client_secret`), and `scrubPii`/`redactText` catch **value-shaped** ones
 * (an address inside a dispute note, a card number inside a webhook payload). An export that ran only
 * the first would happily ship another buyer's email inside a `note` string, which is exactly the
 * leak this function exists to prevent.
 */
function redactSection(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubPii(redactText(value, []))
  if (Array.isArray(value)) return value.map((item) => redactSection(item, seen))
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    // `redact` runs the key-name pass first; the walk then re-scrubs what it kept.
    const walked = redact(value) as Record<string, unknown>
    return Object.fromEntries(Object.entries(walked).map(([k, v]) => [k, redactSection(v, seen)]))
  }
  return value
}

function file(name: string, rows: readonly unknown[] | null): ExportFile {
  return {
    name,
    content: rows === null ? null : redactSection(rows),
    count: rows === null ? null : rows.length,
  }
}

/**
 * Assemble the bundle.
 *
 * Fails closed when the subject has no row: an export for a user id that does not exist is either a
 * typo or an attempt to enumerate, and returning an empty bundle would make the second case look like
 * the first.
 */
export async function buildExport(
  store: PrivacyExportStore,
  userId: string,
  nowSec: number,
): Promise<Result<ExportBundle, CsError>> {
  if (userId.trim() === '') {
    return err(csError('CS_VALIDATION', 'buildExport needs a user id'))
  }
  if (!Number.isInteger(nowSec) || nowSec < 0) {
    return err(
      csError('CS_VALIDATION', `nowSec must be whole epoch seconds, got ${String(nowSec)}`),
    )
  }

  const user = await store.user(userId)
  if (user === null || user === undefined) {
    return err(csError('CS_NOT_FOUND', `No such user: ${userId}`, { userId }))
  }

  const [wallets, mandates, orders, disputes, evidencePackets, privacyRequests] = await Promise.all(
    [
      store.wallets(userId),
      store.mandates(userId),
      store.orders(userId),
      store.disputes(userId),
      store.evidencePackets(userId),
      store.privacyRequests(userId),
    ],
  )

  const files: readonly ExportFile[] = [
    // The account row is exported as the subject's own record, redacted like everything else.
    { name: 'account.json', content: redactSection(user), count: null },
    file('wallets.json', wallets),
    file('mandates.json', mandates),
    file('orders.json', orders),
    file('disputes.json', disputes),
    file('evidence-packets.json', evidencePackets),
    file('privacy-requests.json', privacyRequests),
  ]

  const totalRows = files.reduce((sum, f) => sum + (f.count ?? 0), 0)

  return ok({
    userId,
    generatedAtSec: nowSec,
    files,
    manifest: {
      sections: files.map((f) => f.name),
      totalRows,
      redaction: EXPORT_REDACTION_NOTE,
      retention: EXPORT_RETENTION_NOTE,
    },
  })
}

/**
 * The download filename. Fixed shape, no user-supplied text, because a header assembled from a
 * display name is a header-injection bug waiting for a name with a newline in it.
 */
export function exportFilename(userId: string, nowSec: number): string {
  const safeId = userId.replace(/[^A-Za-z0-9_-]/g, '')
  return `countersign-export-${safeId}-${new Date(nowSec * 1000).toISOString().slice(0, 10)}.json`
}
