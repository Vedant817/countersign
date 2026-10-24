/**
 * Mandate immutability — spec §3.3 (the mandate state machine), §12.4 **EC-MDT-7**.
 *
 * The spec's row for EC-MDT-7 is: *"User edits the intent after signing — Mandates are immutable;
 * editing creates a new mandate and offers to revoke the old one."*
 *
 * The editor flow itself does not exist yet (there is no S-04 route and no production mandate
 * writer — recorded in `docs/edge-cases.json` under EC-MDT-7). What *is* built, and what this file
 * pins, is the half that protects the signature: **the only columns any `.update(mandates)` in this
 * package may write are the state-machine columns.** A future edit that reaches for `nl_intent` —
 * the natural way to build "let the user edit the intent" — fails here instead of silently making a
 * signed mandate mean something its signer never approved.
 *
 * ## Why a source scan, and why it must find its own targets
 *
 * The property is "no such write exists", so there is nothing to call at runtime. The failure mode of
 * this kind of test is the one `docs/COMPILER-EVAL.md` records: a scan whose pattern matches nothing
 * and which then passes vacuously. So the scan asserts it found the two real update sites first, and
 * it looks for the forbidden identifiers **anywhere** between `.update(mandates)` and the `.where(`
 * that follows — shorthand properties (`status,`) included, because a regex that only understood
 * `key:` would have missed exactly the style the existing code uses.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPOS_DIR = join(import.meta.dirname, '..', 'src', 'repos')

/**
 * Columns a signed mandate must never have rewritten by an UPDATE.
 *
 * Every one is part of what the user signed (the L2 payload, the read-back they were shown, or the
 * identifiers the L2 binds), so changing it after signing would make the evidence packet describe an
 * agreement that never existed. `exp`/`iat` are here for the same reason: the signature covers them.
 */
const IMMUTABLE = [
  'nl_intent',
  'readback',
  'readback_sha256',
  'constraints',
  'l2_serialized',
  'l2_payload',
  'nonce',
  'aud',
  'iat',
  'exp',
  'device_id',
  'wallet_id',
  'agent_id',
  'user_id',
] as const

/** Comments carry the prose ("editing creates a new mandate"), so the scan must read code only. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

interface UpdateSite {
  readonly file: string
  readonly line: number
  /** `.update(mandates)` through to the `.where(` — the whole statement body. */
  readonly text: string
}

/**
 * Every `.update(mandates) … .where(` in `src/repos/`.
 *
 * The boundaries are explicit: a regex over the whole file could match a `.set` belonging to another
 * table and report a pass for a statement it never looked at.
 */
function updateSites(): UpdateSite[] {
  const sites: UpdateSite[] = []
  for (const entry of readdirSync(REPOS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const code = stripComments(readFileSync(join(REPOS_DIR, entry.name), 'utf8'))
    let from = 0
    for (;;) {
      const at = code.indexOf('.update(mandates)', from)
      if (at === -1) break
      const where = code.indexOf('.where(', at)
      sites.push({
        file: entry.name,
        line: code.slice(0, at).split('\n').length,
        text: code.slice(at, where === -1 ? undefined : where),
      })
      from = at + 1
    }
  }
  return sites
}

describe('EC-MDT-7: a signed mandate is immutable except for its status', () => {
  it('finds every update site, so the scan cannot pass by matching nothing', () => {
    const sites = updateSites()
    // Two real sites today: `setMandateStatus` and `revokeMandate`. More are fine; **zero is the
    // failure this assertion exists for**, and it is the failure mode this repository has shipped
    // before (a `capOf()` that matched no values, a CI gate that failed unconditionally).
    expect(sites.length).toBeGreaterThanOrEqual(2)
    for (const site of sites) {
      expect(site.text, `${site.file}:${site.line} does not look like an update statement`).toMatch(
        /\.set\(\{/,
      )
      // The state machine is the only reason these statements exist.
      expect(site.text, `${site.file}:${site.line} does not touch status`).toContain('status')
    }
  })

  it('never writes nl_intent, readback, constraints or the L2, so "edit" can only mean "new mandate"', () => {
    for (const site of updateSites()) {
      for (const column of IMMUTABLE) {
        // Word-boundary match, so `content_audit` does not trip `aud` and `expected_at` does not
        // trip `iat`/`exp`. An UPDATE that names any of these is a mandate that no longer matches
        // its signature.
        const pattern = new RegExp(`\\b${column}\\b`)
        expect(
          pattern.test(site.text),
          `${site.file}:${site.line} writes "${column}" — a signed mandate is immutable ` +
            '(EC-MDT-7: editing creates a new mandate; it does not rewrite this one)',
        ).toBe(false)
      }
    }
  })
})
