/**
 * Pseudonymisation — spec §12.13: on erasure, "pseudonymise PII and keep crypto hashes".
 *
 * Two things must survive an erasure, and they pull in opposite directions:
 *
 *  1. **The record must stop identifying the person.** A `users.display_name` that still holds
 *     "Asha Sharma" is not erased, whatever the `privacy_requests` row says.
 *  2. **The record must stay joinable.** Evidence packets, audit entries and budget entries reference
 *     the user by id; the 540-day window exists precisely so those references still resolve. Deleting
 *     the user row outright would make every filed packet reference a ghost.
 *
 * The resolution is the standard one: replace the identifying *values* with a keyed pseudonym derived
 * from the value itself, and keep the digest. The row survives, the joins survive, and the person
 * does not — unless someone holds the original value and the salt, which is the point.
 *
 * **Domain separation is not decoration.** `piiDigest('email', x)` and `piiDigest('name', x)` differ
 * for the same `x`, so a digest cannot be replayed across fields to confirm a guess about the other.
 * The salt comes from the environment (`PRIVACY_PSEUDONYM_SALT`) so that a leaked database alone
 * cannot be brute-forced against a candidate email list, which is the actual attack on a bare
 * `sha256(email)`.
 */
import { createHash } from 'node:crypto'

/** The distinct kinds of personal data this package digests. */
export type PiiKind = 'email' | 'name' | 'phone' | 'address' | 'ip'

/**
 * The salt. Read once per call rather than cached at module load, because the tests set it per case
 * and a cached value would make the second test in a file pass for the first test's reason.
 *
 * A missing salt is **not** an error here: this is a pure library, and the composition root is where
 * configuration is validated (`packages/core`'s env schema owns that). A missing salt yields an
 * unsalted digest, which is weaker but not wrong, and {@link pseudonymSaltConfigured} lets a caller
 * who cares refuse.
 */
function salt(): string {
  return process.env['PRIVACY_PSEUDONYM_SALT'] ?? ''
}

export function pseudonymSaltConfigured(): boolean {
  return salt().length >= 16
}

/**
 * A stable, domain-separated digest of one personal value.
 *
 * Hex SHA-256 over `countersign.pii.v1\0<kind>\0<salt>\0<value>`. The version tag is in the digest
 * input, not just the name, so changing the scheme later cannot silently produce digests that look
 * comparable to the old ones.
 */
export function piiDigest(kind: PiiKind, value: string): string {
  const normalised = kind === 'email' ? value.trim().toLowerCase() : value.trim()
  return createHash('sha256')
    .update(`countersign.pii.v1\u0000${kind}\u0000${salt()}\u0000${normalised}`, 'utf8')
    .digest('hex')
}

/** The displayable pseudonym: `erased:9f86d081` — short, stable, obviously not a person. */
export function pseudonymFor(kind: PiiKind, value: string): string {
  return `erased:${piiDigest(kind, value).slice(0, 8)}`
}

export interface UserPiiRow {
  readonly id: string
  readonly display_name: string
  readonly email: string
  readonly country?: string
}

export interface PseudonymisedUser {
  readonly id: string
  /** Not a name any more: `erased:9f86d081`. */
  readonly display_name: string
  /**
   * The mail column keeps a **deliverable-shaped** but unroutable address
   * (`erased+<digest12>@erased.invalid`) rather than `''`, because the column is `NOT NULL` and
   * several read paths format it. Storing `''` would make an erased user look like a data-quality
   * bug in every report for ever; `.invalid` is reserved by RFC 2606 and can never be delivered to.
   */
  readonly email: string
  /** Kept so the audit chain and the evidence packets can still be cross-referenced (§12.13). */
  readonly email_digest: string
  readonly display_name_digest: string
}

/**
 * Replace a user's identifying values with stable pseudonyms.
 *
 * Pure. The caller decides *when* this is legal (see `planErasure`); this function only knows *how*.
 */
export function pseudonymiseUser(row: UserPiiRow): PseudonymisedUser {
  const emailDigest = piiDigest('email', row.email)
  return {
    id: row.id,
    display_name: pseudonymFor('name', row.display_name),
    email: `erased+${emailDigest.slice(0, 12)}@erased.invalid`,
    email_digest: emailDigest,
    display_name_digest: piiDigest('name', row.display_name),
  }
}

/**
 * The free-text redactor for anything that leaves the system: an export bundle, an evidence packet
 * summary, a support note.
 *
 * Cross-checked against `packages/core`'s `PII_PATTERNS` rather than duplicating it: two independent
 * email regexes is how one path starts leaking while the other's test stays green. This adds only the
 * two shapes core deliberately leaves out — a bare full name is not detectable, so callers must not
 * concatenate one into a string (see §8.19 and `LoggerFields`).
 */
export function redactFreeText(text: string, known: readonly string[] = []): string {
  let out = text
  // Known-value pass first: a name we were handed is removable even though no pattern can find one.
  for (const value of known) {
    if (value.trim().length < 3) continue
    out = out.split(value).join('[redacted]')
  }
  return out
}

/**
 * Has this row already been pseudonymised?
 *
 * The guard for {@link pseudonymiseUser}'s one footgun: running it twice hashes the placeholder and
 * produces a *different* pseudonym for the same person, so the second run silently breaks the join
 * the first one preserved. A caller that finds `true` here should treat the erasure as done.
 */
export function isAlreadyErased(row: { readonly email: string }): boolean {
  return row.email.endsWith('@erased.invalid')
}
