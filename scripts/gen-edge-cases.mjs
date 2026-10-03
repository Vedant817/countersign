/**
 * Extracts the §12 edge-case catalogue from the blueprint into docs/edge-cases.json.
 *
 * The JSON file is the machine-readable source of truth for the edge-case ledger.
 * `scripts/ec-coverage.mjs` turns it (plus a live scan of the test tree) into
 * docs/EDGE_CASES.md, so the published ledger can never drift from the tests.
 *
 * Run: node scripts/gen-edge-cases.mjs            # regenerate from the spec
 *      node scripts/gen-edge-cases.mjs --check    # fail if the JSON is stale
 *
 * Section reference: spec §12, 109 rows.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = join(ROOT, 'docs/spec/countersign-blueprint.md')
const OUT = join(ROOT, 'docs/edge-cases.json')

/** §12 subsections -> owning work package(s). Mirrors spec §15 lanes and §12 headings. */
const SECTION_WP = {
  '12.1': { wp: 'WP-11', module: 'M11 orders', title: 'Captures, refunds and partial refunds' },
  '12.2': { wp: 'WP-06, WP-10, WP-11', module: 'M6/M10/M11', title: 'Duplicates, retries and idempotency' },
  '12.3': { wp: 'WP-12', module: 'M12 webhooks', title: 'Webhooks: loss, duplication, out-of-order' },
  '12.4': { wp: 'WP-10, WP-11', module: 'M10/M11', title: 'Mandates: expiry, revocation, suspension' },
  '12.5': { wp: 'WP-03, WP-10', module: 'M3/M10', title: 'Time and clock skew' },
  '12.6': { wp: 'WP-01, WP-09, WP-11', module: 'M1/M9/M11', title: 'Currency, FX and rounding' },
  '12.7': { wp: 'WP-09, WP-10, WP-11', module: 'M9/M10/M11', title: 'Price, stock and fulfilment' },
  '12.8': { wp: 'WP-15', module: 'M15 defender', title: 'Buyer remorse vs. true fraud vs. friendly fraud' },
  '12.9': { wp: 'WP-05, WP-10, WP-13', module: 'M5/M10/M13', title: 'Agents, keys and people' },
  '12.10': { wp: 'WP-15, WP-18', module: 'M15/M18', title: 'Merchant-side abuse and evidence gaming' },
  '12.11': { wp: 'WP-15, WP-16', module: 'M15/M16', title: 'Disputes: stages, deadlines, chargeback after refund' },
  '12.12': { wp: 'WP-06', module: 'M6 paypal', title: 'PayPal outages, rate limits, sandbox vs. live' },
  '12.13': { wp: 'WP-19', module: 'M19 privacy', title: 'Privacy and data retention' },
  '12.14': { wp: 'WP-08, WP-13, WP-15', module: 'M8/M13/M15', title: 'LLM failures' },
}

/** Split a spec table row into trimmed cells, stripping markdown emphasis and inline code. */
function cells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const raw = trimmed.split('|').map((c) => c.trim())
  return raw.map((c) => c.replace(/\*\*/g, '').replace(/<br>/g, '; ').replace(/`/g, '').trim())
}

function parse() {
  const spec = readFileSync(SPEC, 'utf8')
  const lines = spec.split(/\r?\n/)

  const rows = []
  let section = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const secMatch = line.match(/^###\s+(12\.\d+)\s+(.*)$/)
    if (secMatch) {
      section = secMatch[1]
      continue
    }
    if (/^##\s+13\./.test(line)) section = null

    const idMatch = line.match(/^\|\s*(EC-[A-Z]+-\d+)\s*\|/)
    if (!idMatch || !section) continue

    const c = cells(line)
    const id = idMatch[1]

    // §12.13 has two tables; the second (ID | Scenario | Handling | Test | User-facing) has no
    // "Detection" column. Detect by whether the header for this block declared one.
    const hasDetection = hasDetectionFor(lines, i)

    rows.push({
      id,
      section,
      sectionTitle: SECTION_WP[section]?.title ?? section,
      wp: SECTION_WP[section]?.wp ?? 'unassigned',
      module: SECTION_WP[section]?.module ?? 'unassigned',
      scenario: c[1] ?? '',
      detection: hasDetection ? (c[2] ?? '') : '',
      handling: c[hasDetection ? 3 : 2] ?? '',
      declaredTest: c[hasDetection ? 4 : 3] ?? '',
      userFacing: c[hasDetection ? 5 : 4] ?? '',
      specLine: i + 1,
    })
  }

  return rows
}

/** Walk back to the nearest table header row and report whether it has a "Detection" column. */
function hasDetectionFor(lines, index) {
  for (let j = index; j > 0 && j > index - 40; j--) {
    const l = lines[j]
    if (!l.trim().startsWith('|')) break
    const header = cells(l).map((c) => c.toLowerCase())
    if (header.includes('id')) return header.includes('detection')
  }
  return true
}

function main() {
  const rows = parse()

  const seen = new Set()
  const dupes = []
  for (const r of rows) {
    if (seen.has(r.id)) dupes.push(r.id)
    seen.add(r.id)
  }
  if (dupes.length) {
    console.error(`Duplicate EC ids in spec: ${[...new Set(dupes)].join(', ')}`)
    process.exit(1)
  }
  if (rows.length !== 109) {
    console.error(`Expected 109 edge cases in spec §12, parsed ${rows.length}. Refusing to write.`)
    process.exit(1)
  }

  // Preserve any hand-maintained fields from a previous run (status, blockedReason, notes).
  const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { cases: [] }
  const priorById = new Map(prior.cases.map((c) => [c.id, c]))
  for (const r of rows) {
    const p = priorById.get(r.id)
    if (p) {
      r.status = p.status ?? 'todo'
      r.blockedReason = p.blockedReason
      r.notes = p.notes
    } else {
      r.status = 'todo'
    }
  }

  const payload = {
    $comment:
      'Generated by scripts/gen-edge-cases.mjs from docs/spec/countersign-blueprint.md §12. ' +
      '`status`, `blockedReason` and `notes` are hand-maintained and preserved across regeneration. ' +
      'Test references are NOT stored here: scripts/ec-coverage.mjs scans the test tree for ' +
      '`EC-<GROUP>-<N>` markers and generates docs/EDGE_CASES.md from the result.',
    spec: 'docs/spec/countersign-blueprint.md',
    specSection: '12',
    total: rows.length,
    cases: rows,
  }

  const next = JSON.stringify(payload, null, 2) + '\n'

  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (current !== next) {
      console.error('docs/edge-cases.json is stale. Run: node scripts/gen-edge-cases.mjs')
      process.exit(1)
    }
    console.log('docs/edge-cases.json is up to date (109 cases).')
    return
  }

  writeFileSync(OUT, next)
  const bySection = new Map()
  for (const r of rows) bySection.set(r.section, (bySection.get(r.section) ?? 0) + 1)
  console.log(`Wrote ${OUT} with ${rows.length} cases.`)
  for (const [s, n] of [...bySection].sort()) console.log(`  §${s}: ${n}`)
}

main()