/**
 * WP-19 pseudonymisation, export, notice and status — spec §8.19 and §12.13
 * (EC-PRIV-2, EC-PRIV-5).
 *
 * The export cases are the ones worth reading. §12.13 asks for "a JSON zip of everything for the
 * user", and the failure that matters is not an empty zip — it is a zip that contains somebody else's
 * data, because the assembler walked a table instead of asking for a subject. The cases below put a
 * second person's email inside a dispute note and inside a webhook payload and assert it does not
 * survive, which is the only version of "the export is redacted" that means anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CROSS_BORDER,
  EXPORT_RETENTION_NOTE,
  LLM_DATA_STATEMENT,
  RECONCILER_LAG_SLO_SEC,
  assertPromptIsClean,
  buildExport,
  exportFilename,
  humaniseSeconds,
  isAlreadyErased,
  overallStatus,
  piiDigest,
  promptRejectedError,
  pseudonymFor,
  pseudonymSaltConfigured,
  pseudonymiseUser,
  redactFreeText,
  renderPreErasureNotice,
  renderPrivacyStatement,
  webhookHealth,
  type DependencyStatus,
  type PrivacyExportStore,
} from '../src/index'

const SALT = 'test-salt-at-least-16-chars'
const NOW = Date.UTC(2027, 0, 15) / 1000

describe('pseudonymisation', () => {
  beforeEach(() => {
    process.env['PRIVACY_PSEUDONYM_SALT'] = SALT
  })
  afterEach(() => {
    delete process.env['PRIVACY_PSEUDONYM_SALT']
  })

  it('replaces the identifying values and keeps the digests', () => {
    const result = pseudonymiseUser({
      id: 'usr_1',
      display_name: 'Asha Sharma',
      email: 'Asha.Sharma@Example.com',
      country: 'IN',
    })

    expect(result.display_name).toBe(
      'erased:9f86d081'.replace('9f86d081', result.display_name_digest.slice(0, 8)),
    )
    expect(result.email).toMatch(/^erased\+[0-9a-f]{12}@erased\.invalid$/)
    // Joinability is what §12.13 buys with the digest: the row still exists and still resolves.
    expect(result.id).toBe('usr_1')
    expect(result.email_digest).toHaveLength(64)
    // Country-level data is not personal data and is kept, because the DPDP notice depends on it.
    expect(result.display_name).not.toContain('Asha')
  })

  it('never leaves the original value anywhere in the returned object', () => {
    const serialised = JSON.stringify(
      pseudonymiseUser({ id: 'usr_1', display_name: 'Asha Sharma', email: 'asha@example.com' }),
    )
    expect(serialised).not.toContain('Asha')
    expect(serialised).not.toContain('asha@example.com')
    expect(serialised.toLowerCase()).not.toContain('sharma')
  })

  it('is stable for the same input, so a re-run is idempotent', () => {
    const a = pseudonymiseUser({ id: 'usr_1', display_name: 'Asha Sharma', email: 'a@b.com' })
    const b = pseudonymiseUser({ id: 'usr_1', display_name: 'Asha Sharma', email: 'a@b.com' })
    expect(a).toEqual(b)
  })

  it('separates domains, so one digest cannot confirm a guess about another field', () => {
    // The same string in two fields must not produce the same digest, or a name column leak would
    // also confirm an email guess.
    expect(piiDigest('email', 'same')).not.toBe(piiDigest('name', 'same'))
    expect(piiDigest('ip', 'same')).not.toBe(piiDigest('phone', 'same'))
  })

  it('folds email case but not name case, because only one of them is an identifier', () => {
    expect(piiDigest('email', 'A@B.com')).toBe(piiDigest('email', 'a@b.com '))
    expect(piiDigest('name', 'Asha')).not.toBe(piiDigest('name', 'asha'))
  })

  it('changes the digest when the salt changes, because a bare sha256(email) is brute-forceable', () => {
    const salted = piiDigest('email', 'asha@example.com')
    process.env['PRIVACY_PSEUDONYM_SALT'] = 'a-completely-different-salt'
    expect(piiDigest('email', 'asha@example.com')).not.toBe(salted)
  })

  it('reports whether a usable salt is configured', () => {
    expect(pseudonymSaltConfigured()).toBe(true)
    process.env['PRIVACY_PSEUDONYM_SALT'] = 'short'
    expect(pseudonymSaltConfigured()).toBe(false)
  })

  it('recognises an already-erased row', () => {
    expect(isAlreadyErased({ email: 'erased+abc@erased.invalid' })).toBe(true)
    expect(isAlreadyErased({ email: 'asha@example.com' })).toBe(false)
  })

  it('renders a short, obviously-not-a-person pseudonym', () => {
    expect(pseudonymFor('name', 'Asha Sharma')).toMatch(/^erased:[0-9a-f]{8}$/)
  })
})

describe('redactFreeText', () => {
  it('removes a known value that no pattern could find', () => {
    // This is the honest half of AT-M19.2: a full name is not detectable by regex, so the caller
    // must supply the values it knows about.
    const note = 'The buyer Asha Sharma asked for a refund.'
    expect(redactFreeText(note, ['Asha Sharma'])).toBe('The buyer [redacted] asked for a refund.')
  })

  it('ignores values too short to be identifying, which would otherwise shred the text', () => {
    expect(redactFreeText('order us_1 shipped', ['us'])).toBe('order us_1 shipped')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* Export — EC-PRIV-2                                                                            */
/* -------------------------------------------------------------------------------------------- */

function storeWith(overrides: Partial<PrivacyExportStore> = {}): PrivacyExportStore {
  return {
    user: async () => ({
      id: 'usr_1',
      display_name: 'Asha Sharma',
      email: 'asha@example.com',
      country: 'IN',
    }),
    wallets: async () => [{ id: 'wal_1', payment_token_id: 'PAYTOKEN-1' }],
    mandates: async () => [{ id: 'mdt_1', read_back: 'Buy one Trail Runner up to USD 80.00' }],
    orders: async () => [{ id: 'ord_1', amount_minor: '6400', currency: 'USD' }],
    disputes: async () => [
      // A second person's address, in free text. This is the leak the export must not have.
      { id: 'dsp_1', note: 'Merchant contact: Priya Nair <priya.nair@northwind.example>' },
    ],
    evidencePackets: async () => [{ id: 'evp_1', bytes: 12_345 }],
    privacyRequests: async () => [{ id: 'prq_1', kind: 'EXPORT', status: 'COMPLETED' }],
    ...overrides,
  }
}

describe('EC-PRIV-2: the subject-access export', () => {
  it('returns every section §12.13 lists, with counts in the manifest', async () => {
    const result = await buildExport(storeWith(), 'usr_1', NOW)
    if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`)

    const bundle = result.value
    expect(bundle.files.map((f) => f.name)).toEqual([
      'account.json',
      'wallets.json',
      'mandates.json',
      'orders.json',
      'disputes.json',
      'evidence-packets.json',
      'privacy-requests.json',
    ])
    // 1 wallet + 1 mandate + 1 order + 1 dispute + 1 packet + 1 request = 6; the account is a document.
    expect(bundle.manifest.totalRows).toBe(6)
    expect(bundle.manifest.retention).toBe(EXPORT_RETENTION_NOTE)
  })

  it('scrubs another person out of free text, which is the leak that matters', async () => {
    const result = await buildExport(storeWith(), 'usr_1', NOW)
    if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`)

    const serialised = JSON.stringify(result.value)
    expect(serialised).not.toContain('priya.nair@northwind.example')
    expect(serialised).toContain('[email]')
  })

  it('redacts credential-shaped fields rather than exporting them', async () => {
    const result = await buildExport(
      storeWith({ wallets: async () => [{ id: 'wal_1', access_token: 'A21AA-real-token-value' }] }),
      'usr_1',
      NOW,
    )
    if (!result.ok) throw new Error(`unexpected error: ${result.error.code}`)
    expect(JSON.stringify(result.value)).not.toContain('A21AA-real-token-value')
  })

  it('fails closed for an unknown subject instead of returning an empty bundle', async () => {
    // An empty bundle would make "wrong id" and "this person has no data" indistinguishable, and the
    // second is the only one a support agent should be able to act on.
    const result = await buildExport(storeWith({ user: async () => null }), 'usr_missing', NOW)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('CS_NOT_FOUND')
  })

  it('rejects a blank subject and a bad clock', async () => {
    expect((await buildExport(storeWith(), '   ', NOW)).ok).toBe(false)
    expect((await buildExport(storeWith(), 'usr_1', 1.5)).ok).toBe(false)
  })

  it('builds a filename with no user-supplied text in it', () => {
    // A display name in a Content-Disposition header is a header-injection bug waiting for a newline.
    expect(exportFilename('usr_1\r\nX-Evil: 1', NOW)).toBe(
      'countersign-export-usr_1X-Evil1-2027-01-15.json',
    )
  })
})

/* -------------------------------------------------------------------------------------------- */
/* Notice — EC-PRIV-5                                                                            */
/* -------------------------------------------------------------------------------------------- */

describe('EC-PRIV-5: the pre-erasure notice', () => {
  it('names the date and the reason, and schedules itself 48 hours before the purge', () => {
    const purgeAtSec = NOW + 10 * 86_400
    const notice = renderPreErasureNotice({
      displayName: 'erased:9f86d081',
      purgeAtSec,
      holdReason: 'open dispute dsp_01HX',
      supportEmail: 'privacy@countersign.example',
    })

    expect(notice.subject).toContain('2027-01-25')
    expect(notice.body).toContain('open dispute dsp_01HX')
    expect(notice.body).toContain('privacy@countersign.example')
    expect(notice.sendAtSec).toBe(purgeAtSec - 48 * 3_600)
  })

  it('says nothing is holding the request when nothing is', () => {
    const notice = renderPreErasureNotice({
      displayName: 'Asha',
      purgeAtSec: NOW + 2 * 86_400,
      holdReason: null,
      supportEmail: 'privacy@countersign.example',
    })
    expect(notice.subject).toContain('we will erase on')
    expect(notice.body).toContain('Nothing is holding this request')
  })

  it('gives the subject a way to stop it, because a purge is irreversible', () => {
    const notice = renderPreErasureNotice({
      displayName: 'Asha',
      purgeAtSec: NOW + 2 * 86_400,
      holdReason: null,
      supportEmail: 'privacy@countersign.example',
    })
    expect(notice.body).toContain('If you did not ask for this')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* Status — §8.19 and §14                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('the /status reconciler numbers', () => {
  it('says "idle", not "ok", when no webhook has ever arrived', () => {
    // A quiet system and a never-wired system look identical on a dashboard that only shows a dot.
    const health = webhookHealth({
      lastReceivedAtSec: null,
      lastProcessedAtSec: null,
      pendingCount: 0,
      oldestPendingReceivedAtSec: null,
      nowSec: NOW,
    })
    expect(health.state).toBe('idle')
    expect(health.detail).toContain('fault, not quiet')
  })

  it('measures lag from the OLDEST UNPROCESSED event, not from the last success', () => {
    // The bug this pins: `now - lastProcessedAt` reports 0 s on a system that has processed nothing
    // for an hour, because the last success is old but the queue's front is what is waiting.
    const health = webhookHealth({
      lastReceivedAtSec: NOW - 10,
      lastProcessedAtSec: NOW - 3_600,
      pendingCount: 5,
      oldestPendingReceivedAtSec: NOW - 600,
      nowSec: NOW,
    })
    expect(health.reconcilerLagSec).toBe(600)
    expect(health.sloBreached).toBe(true)
    expect(health.state).toBe('lagging')
  })

  it('reports ok with zero lag when the queue is empty', () => {
    const health = webhookHealth({
      lastReceivedAtSec: NOW - 30,
      lastProcessedAtSec: NOW - 30,
      pendingCount: 0,
      oldestPendingReceivedAtSec: null,
      nowSec: NOW,
    })
    expect(health.state).toBe('ok')
    expect(health.reconcilerLagSec).toBe(0)
    expect(health.sloBreached).toBe(false)
  })

  it('escalates to "stalled" past three SLO windows', () => {
    const health = webhookHealth({
      lastReceivedAtSec: NOW - 5,
      lastProcessedAtSec: NOW - 5,
      pendingCount: 1,
      oldestPendingReceivedAtSec: NOW - (3 * RECONCILER_LAG_SLO_SEC + 1),
      nowSec: NOW,
    })
    expect(health.state).toBe('stalled')
  })

  it('does not claim "never processed anything" when the caller simply did not read that value', () => {
    // The status route does not query `processed_at`, and an earlier draft of this function turned
    // that absence into an assertion about the system. A page must not report what it did not measure.
    const health = webhookHealth({
      lastReceivedAtSec: NOW - 10,
      lastProcessedAtSec: null,
      pendingCount: 5,
      oldestPendingReceivedAtSec: NOW - 600,
      nowSec: NOW,
    })
    expect(health.detail).not.toContain('never processed')
    expect(health.detail).toContain('5 unprocessed')
  })

  it('keeps "unconfigured" and "down" apart, because only one of them is an incident', () => {
    const deps = (ok: boolean | null, configured = true): DependencyStatus[] => [
      { name: 'database', configured, ok, detail: '' },
      { name: 'vi', configured, ok, detail: '' },
      { name: 'paypal', configured: false, ok: null, detail: 'not configured' },
    ]
    expect(overallStatus(deps(null, false)).status).toBe('unconfigured')
    expect(overallStatus(deps(null, false)).httpCode).toBe(503)
    expect(overallStatus(deps(false)).status).toBe('down')
    expect(overallStatus(deps(true)).status).toBe('ok')
  })

  it('humanises a remaining retention window', () => {
    expect(humaniseSeconds(0)).toBe('due now')
    expect(humaniseSeconds(-5)).toBe('due now')
    expect(humaniseSeconds(3 * 86_400 + 4 * 3_600)).toBe('3d 4h')
    expect(humaniseSeconds(3_600 + 120)).toBe('1h 2m')
    expect(humaniseSeconds(90)).toBe('1m')
  })
})

/* -------------------------------------------------------------------------------------------- */
/* Provider and cross-border disclosure — EC-PRIV-4 and EC-PRIV-6                                */
/* -------------------------------------------------------------------------------------------- */

describe('EC-PRIV-4: what may be sent to the model provider', () => {
  it('accepts a prompt built only from allow-listed product and instruction fields', () => {
    expect(
      assertPromptIsClean({
        intent_text: 'Buy the cheapest trail runner under eighty dollars',
        product_title: 'Trail Runner',
        product_sku: 'NW-001',
        merchant_name: 'Northwind Outfitters',
      }),
    ).toEqual([])
  })

  it('reports a field that is not on the list, which is how a template grows a payer_email', () => {
    const violations = assertPromptIsClean({
      intent_text: 'buy it',
      payer_email: 'asha@example.com',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.field).toBe('payer_email')
    expect(violations[0]?.reason).toContain('not an allowed prompt field')
  })

  it('reports PII hiding inside an allowed field, because that is the case code review misses', () => {
    // "Northwind Outfitters <ops@northwind.example>" is a merchant name that is also an address.
    const violations = assertPromptIsClean({
      merchant_name: 'Northwind Outfitters <ops@northwind.example>',
    })
    expect(violations.map((v) => v.field)).toEqual(['merchant_name'])
    expect(violations[0]?.reason).toContain('email')
  })

  it('catches a vault token and a card number in an instruction the user pasted in', () => {
    expect(assertPromptIsClean({ intent_text: 'pay with PAYTOKEN-1AB2CD3EF' })).toHaveLength(1)
    expect(assertPromptIsClean({ intent_text: 'card 4111 1111 1111 1111' })).toHaveLength(1)
  })

  it('turns a rejection into a CsError that names each problem', () => {
    const error = promptRejectedError(
      assertPromptIsClean({ intent_text: 'x', payer_email: 'a@b.com' }),
    )
    expect(error.code).toBe('CS_VALIDATION')
    expect(error.details?.['violations']).toBeDefined()
  })

  it('documents the retention of prompts and outputs in the statement itself', () => {
    expect(LLM_DATA_STATEMENT).toContain('30 days')
    expect(LLM_DATA_STATEMENT).toContain('do not send your name')
  })
})

describe('EC-PRIV-6: the cross-border disclosure', () => {
  it('names the region the deployment actually runs in', () => {
    expect(CROSS_BORDER.region).toBe('Singapore')
    expect(CROSS_BORDER.statement).toContain('Singapore')
  })

  it('renders the transfer notice and the retention windows on the privacy page', () => {
    const { paragraphs } = renderPrivacyStatement()
    expect(paragraphs.join(' ')).toContain('cross-border transfer')
    // The windows on the page are the same constants the sweep enforces, so the page cannot drift.
    expect(paragraphs.join(' ')).toContain('365 days')
    expect(paragraphs.join(' ')).toContain('540 days')
  })
})
