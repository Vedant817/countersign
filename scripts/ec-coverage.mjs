/**
 * Regenerates docs/EDGE_CASES.md from docs/edge-cases.json plus a live scan of the test tree,
 * and gates the build on every spec §12 edge case having a real test.
 *
 * How a test claims an edge case: its title (or any comment line above it) contains the exact id,
 * e.g. `it('EC-CAP-1 partial capture allocates the shipment share', ...)` or
 * `def test_ec_cap_1_partial_capture(): ...`.
 *
 * Usage:
 *   node scripts/ec-coverage.mjs                 # write docs/EDGE_CASES.md, gate on completeness
 *   node scripts/ec-coverage.mjs --report        # print the table, do not fail
 *   node scripts/ec-coverage.mjs --allow-incomplete  # during development
 *
 * Exit codes: 0 pass, 1 incomplete coverage or stale id list.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(ROOT, 'docs/edge-cases.json')
const DOC = join(ROOT, 'docs/EDGE_CASES.md')

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'playwright-report',
  'test-results',
  '.artifacts',
])

const TEST_FILE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|test_[^/]*\.py|[^/]*_test\.py)$/

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (TEST_FILE.test(name)) out.push(full)
  }
  return out
}

const ID_RE = /\b(EC-[A-Z]+-\d+)\b/g

/**
 * Walks each test file line by line, keeping a small context window above the current line so an
 * `EC-…` marker in a comment (`// EC-WH-4 forged webhook`) also counts. Records the enclosing
 * `it(`/`test(`/`def test_` title plus a test-function name when one exists.
 */
function scan(file) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split(/\r?\n/)
  const hits = []
  const rel = relative(ROOT, file).split(sep).join('/')

  let fnName = null
  const fnStack = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const pyDef = line.match(/^\s*def\s+(test_[A-Za-z0-9_]+)/)
    const tsFn = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/)
    const desc = line.match(/\b(?:it|test|describe)\s*\(\s*(['"`])(.*?)\1/)
    if (pyDef || tsFn) {
      fnName = (pyDef ?? tsFn)[1]
      fnStack.push(fnName)
    }
    if (desc) fnName = fnName ?? null

    const window = [lines[i - 2], lines[i - 1], line].filter(Boolean).join('\n')
    const found = window.match(ID_RE)
    if (!found) continue

    for (const id of new Set(found)) {
      hits.push({ id, file: rel, line: i + 1, title: desc ? desc[2] : null, fn: fnName })
    }
  }
  return hits
}

/** Which test type letters a spec §12 row promised (S/U/I/E/P). */
function declaredTypes(declaredTest) {
  return [...new Set((declaredTest.match(/[SUIEP]/g) ?? []))].sort().join('')
}

function build() {
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'))
  const cases = ledger.cases

  const files = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'scripts'))]
  const hits = files.flatMap(scan)

  const byId = new Map()
  for (const c of cases) byId.set(c.id, [])
  const unknown = []
  for (const h of hits) {
    if (byId.has(h.id)) byId.get(h.id).push(h)
    else unknown.push(h)
  }

  const rows = cases.map((c) => {
    const tests = byId.get(c.id)
    return {
      ...c,
      testCount: tests.length,
      tests: dedupeTests(tests),
      types: declaredTypes(c.declaredTest),
    }
  })

  return { rows, unknown }
}

function dedupeTests(tests) {
  const seen = new Map()
  for (const t of tests) {
    const key = `${t.file}:${t.line}`
    if (!seen.has(key)) seen.set(key, t)
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function escape(s) {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}

function statusOf(r) {
  if (r.status === 'blocked') return r.testCount > 0 ? 'blocked (tested)' : 'blocked (no test)'
  if (r.testCount === 0) return r.status === 'wip' ? 'wip — no test' : 'todo — no test'
  return r.status === 'done' ? 'done' : `${r.status} — ${r.testCount} test${r.testCount > 1 ? 's' : ''}`
}

function render(rows, generatedAt) {
  const done = rows.filter((r) => r.testCount > 0).length
  const closed = rows.filter((r) => r.status === 'done' && r.testCount > 0).length
  const blocked = rows.filter((r) => r.status === 'blocked').length

  const out = []
  out.push('# EDGE_CASES — the §12 catalogue, mapped to code and tests')
  out.push('')
  out.push('<!-- GENERATED FILE — do not edit by hand. -->')
  out.push('<!-- Source of truth: docs/edge-cases.json (extracted from the spec by')
  out.push('     scripts/gen-edge-cases.mjs). Test references come from a live scan of the test')
  out.push('     tree by scripts/ec-coverage.mjs. Edit `status`, `blockedReason` and `notes` in')
  out.push('     docs/edge-cases.json, then run `pnpm test:ec`. -->')
  out.push('')
  out.push(`_Generated ${generatedAt}._`)
  out.push('')
  out.push('| Metric | Value |')
  out.push('|---|---|')
  out.push(`| Edge cases in spec §12 | **${rows.length}** |`)
  out.push(`| Cases with at least one referencing test | **${done}** |`)
  out.push(`| Cases fully \`done\` (test present + status done) | **${closed}** |`)
  out.push(`| Cases \`blocked\` (needs live sandbox / human step) | **${blocked}** |`)
  out.push(`| Total test references | **${rows.reduce((n, r) => n + r.testCount, 0)}** |`)
  out.push('')
  out.push('A test claims a case by naming it in the test title or in a comment on the line above,')
  out.push("e.g. `it('EC-CAP-1 …')` or `// EC-WH-4 forged webhook`.")
  out.push('')

  let lastSection = null
  for (const r of rows) {
    if (r.section !== lastSection) {
      lastSection = r.section
      out.push('')
      out.push(`## §${r.section} ${r.sectionTitle}`)
      out.push('')
      out.push(`Owning work package(s): \`${r.wp}\` · module: \`${r.module}\` · spec line ${r.specLine}`)
      out.push('')
      out.push('| ID | Scenario | Handling | Declared | Test(s) | Status |')
      out.push('|---|---|---|---|---|---|')
    }
    const testCells = r.tests.length
      ? r.tests
          .map((t) => `\`${t.file}:${t.line}\`${t.title ? ` — ${escape(t.title)}` : ''}`)
          .join('<br>')
      : '—'
    out.push(
      `| **${r.id}** | ${escape(r.scenario)} | ${escape(r.handling)} | ${r.types || '—'} | ${testCells} | ${statusOf(r)} |`,
    )
    if (r.notes) out.push(`| | _note:_ ${escape(r.notes)} | | | | |`)
    if (r.blockedReason) out.push(`| | _blocked:_ ${escape(r.blockedReason)} | | | | |`)
  }

  out.push('')
  out.push('---')
  out.push('')
  out.push('## How to close a case')
  out.push('')
  out.push('1. Write the test, naming the EC id in the title or in a comment directly above it.')
  out.push('2. Put the handling code in the module the `wp` column names.')
  out.push('3. Set `status` to `done` in `docs/edge-cases.json` (or `blocked` with a `blockedReason`).')
  out.push('4. Run `pnpm test:ec`. It regenerates this file and fails if anything is unclaimed.')
  out.push('')

  return out.join('\n')
}

function main() {
  const { rows, unknown } = build()
  const allowIncomplete = process.argv.includes('--allow-incomplete')

  const unclaimed = rows.filter((r) => r.testCount === 0 && r.status !== 'blocked' && r.status !== 'dropped')
  const claimedNotDone = rows.filter((r) => r.testCount > 0 && r.status === 'todo')
  const badStatus = rows.filter((r) => !['todo', 'wip', 'done', 'blocked', 'dropped'].includes(r.status))
  const blockedNoReason = rows.filter((r) => r.status === 'blocked' && !r.blockedReason)

  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z'
  writeFileSync(DOC, render(rows, generatedAt))

  const total = rows.length
  const withTest = rows.filter((r) => r.testCount > 0).length
  console.log(`\nEDGE-CASE COVERAGE  ${withTest}/${total} cases have a referencing test`)
  console.log('─'.repeat(72))
  for (const r of rows.filter((x) => x.testCount === 0)) {
    console.log(`  ✗ ${r.id.padEnd(12)} ${statusOf(r).padEnd(20)} ${r.scenario.slice(0, 60)}`)
  }
  if (unknown.length) {
    console.log('\n  References to ids that are not in the spec catalogue:')
    for (const u of unknown) console.log(`    ? ${u.id} at ${u.file}:${u.line}`)
  }
  console.log('─'.repeat(72))
  console.log(`  wrote docs/EDGE_CASES.md`)
  console.log(`  ${rows.reduce((n, r) => n + r.testCount, 0)} test references total\n`)

  const problems = []
  if (unknown.length) problems.push(`${unknown.length} test reference(s) use an EC id outside spec §12`)
  if (badStatus.length) {
    problems.push(
      `invalid status for ${badStatus.map((r) => `${r.id}=${r.status}`).join(', ')}`,
    )
  }
  if (blockedNoReason.length) {
    problems.push(`blocked without a reason: ${blockedNoReason.map((r) => r.id).join(', ')}`)
  }
  if (!allowIncomplete && unclaimed.length) {
    problems.push(`${unclaimed.length} case(s) have no referencing test and are not marked blocked`)
  }

  if (problems.length) {
    for (const p of problems) console.error(`FAIL  ${p}`)
    if (allowIncomplete) console.error('\n(--allow-incomplete: not failing the build)')
    else process.exit(1)
  }
  console.log('OK    edge-case ledger complete.\n')
}

main()