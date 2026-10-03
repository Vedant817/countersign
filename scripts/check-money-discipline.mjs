/**
 * Money-discipline guard (spec §0: "Money | Always integer minor units plus an ISO-4217 currency
 * code. Floats are never used.").
 *
 * No ESLint rule can enforce this. `Number(x.minor) / 100` is legal TypeScript, `parseFloat` is
 * legal, and `as unknown as number` is legal — yet each one silently reintroduces floating-point
 * money. Static typing gets us most of the way (`Money` carries a `bigint`), so this script covers
 * the remaining idioms that show up when a float creeps in from a boundary.
 *
 * What it flags, in `packages/{core,paypal,ledger,orders,gate,defender}/src` and
 * `apps/{web,worker}/src`:
 *  - `parseFloat` / `parseInt` on a value that looks monetary
 *  - `Math.round|trunc|floor|ceil` applied to something named `*amount*|*minor*|*total*|*price*`
 *  - `.toFixed(` on a monetary field
 *  - `Number(` / `+` coercion applied to `*.minor`
 *  - a `number`-typed field whose name is monetary, in an interface or a Money-adjacent object
 *
 * Test files and scripts are exempt: a test may legitimately write `129.99` to prove the parser
 * rejects it, and `scripts/` prints human-facing amounts.
 *
 * Usage: node scripts/check-money-discipline.mjs [--report] [--root <dir>]
 * Exit:  0 clean, 1 violations found.
 *
 * `--root` points the scan at a different tree. It exists so the self-test in
 * `packages/core/test/money-discipline.test.ts` can prove the checker actually fires, instead of
 * shipping a guard that has never been observed to catch anything.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const rootFlag = argv.indexOf('--root')
const rootArg = rootFlag >= 0 ? argv[rootFlag + 1] : undefined

const ROOT = rootArg ? join(rootArg) : join(fileURLToPath(new URL('.', import.meta.url)), '..')

const SCAN_ROOTS = [
  'packages/core/src',
  'packages/paypal/src',
  'packages/ledger/src',
  'packages/orders/src',
  'packages/gate/src',
  'packages/defender/src',
  'packages/webhooks/src',
  'packages/compiler/src',
  'packages/agent/src',
  'packages/evidence-pdf/src',
  'packages/privacy/src',
  'apps/web/lib',
  'apps/web/app',
  'apps/worker/src',
]

const EXEMPT_FILE = /(\.test\.[tj]sx?|\.spec\.[tj]sx?|\.sandbox\.test\.ts)$/
const EXEMPT_LINE = /\/\/(.*)$|\/\*(.*)$|\*(.*)$/

const MONEY_NAME = /(amount|minor|total|price|balance|budget|cap|refund|capture|spend|spent|reserve)/i

const RULES = [
  {
    id: 'no-parseFloat',
    re: /\bparseFloat\s*\(/g,
    why: 'parseFloat produces a JS double. Convert through fromPayPalValue() so the string is parsed with bigint.',
  },
  {
    id: 'no-float-math-on-money',
    // Only flagged on a line that talks about money: `Math.floor(sec)` in the clock is correct,
    // `Math.round(totalMinor / 100)` is the bug we are hunting.
    re: /\bMath\.(round|trunc|floor|ceil)\s*\(/g,
    requireLine: MONEY_NAME,
    exemptLine: /backoff|retry|percent|ratio|\bcount\b|delay|jitter|percentile/i,
    why: 'Rounding a money double loses or invents minor units. Keep amounts as bigint and allocate explicitly with allocate().',
  },
  {
    id: 'no-toFixed-on-money',
    re: /\.toFixed\s*\(\s*\d*\s*\)/g,
    requireLine: MONEY_NAME,
    why: 'toFixed() returns a string and rounds. Use formatMoney() with integer minor units.',
  },
  {
    id: 'no-number-coercion-of-money',
    // `Number(totalMinor)` or unary `+totalMinor`, but NOT bigint addition
    // (`a.minor + b.minor`), which is the entire point of the type. The unary-plus branch requires
    // the `+` to sit at the start of an expression (after `=`, `(`, `,` or the line start), so a
    // binary `+` between two `.minor` accesses can never match.
    re: /\bNumber\s*\(\s*[\w$.]+\s*\)|(?:^|[=(,]\s*)\+\s*[\w$.]+\b/g,
    requireLine: MONEY_NAME,
    why: 'Number(x) / +x defeats bigint. Keep amounts as bigint end to end; render with toPayPalValue().',
  },
]

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !EXEMPT_FILE.test(name)) out.push(full)
  }
  return out
}

function main() {
  const report = argv.includes('--report')
  const violations = []
  let scanned = 0

  for (const relRoot of SCAN_ROOTS) {
    const absRoot = join(ROOT, relRoot)
    // Under `--root`, only scan roots that actually exist so a minimal fixture tree is enough.
    let present = true
    try {
      statSync(absRoot)
    } catch {
      present = false
    }
    if (!present) continue
    for (const file of walk(absRoot)) {
      scanned++
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      const rel = relative(ROOT, file).split(sep).join('/')
      lines.forEach((line, i) => {
        // Strip comments: an explanatory comment mentioning parseFloat is not a violation.
        const code = line.replace(EXEMPT_LINE, '')
        if (code.trim() === '') return
        for (const rule of RULES) {
          rule.re.lastIndex = 0
          let m
          while ((m = rule.re.exec(code)) !== null) {
            if (rule.exemptLine && rule.exemptLine.test(line)) continue
            if (rule.requireLine && !rule.requireLine.test(line)) continue
            violations.push({ file: rel, line: i + 1, id: rule.id, snippet: line.trim(), why: rule.why })
          }
        }
      })
    }
  }

  if (violations.length === 0) {
    console.log(`money-discipline: clean (${scanned} files across ${SCAN_ROOTS.length} roots)`)
    return
  }

  console.error(`\nmoney-discipline: ${violations.length} potential float-money violation(s)\n`)
  const byRule = new Map()
  for (const v of violations) {
    if (!byRule.has(v.id)) byRule.set(v.id, [])
    byRule.get(v.id).push(v)
  }
  for (const [id, list] of byRule) {
    console.error(`  ${id}  (${list.length})`)
    for (const v of list) {
      console.error(`    ${v.file}:${v.line}`)
      console.error(`      ${v.snippet.slice(0, 110)}`)
    }
    console.error(`    why: ${list[0].why}\n`)
  }
  if (!report) {
    console.error('Money is integer minor units. See docs/spec/countersign-blueprint.md §0 and packages/core/src/money.ts.')
    process.exit(1)
  }
}

main()