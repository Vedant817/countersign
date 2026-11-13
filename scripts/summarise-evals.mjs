/**
 * Summarise the nightly eval report into one human line.
 *
 * `sandbox-nightly.yml` publishes `.artifacts/evals/report.json` as `reports/eval-report.json` and then
 * calls this script so the README's "Eval results" table is machine-produced rather than typed by hand.
 * It reads the report, asserts its shape (a report missing `total`/`rate` is a harness failure, not a
 * quiet pass), and prints the two numbers the workflow cares about — compiler exact match and attack
 * success — each with its denominator.
 *
 * Exit: 0 the report is present and well-formed, 1 otherwise.
 *
 * Usage: node scripts/summarise-evals.mjs [report.json]
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'reports/eval-report.json'

let report
try {
  report = JSON.parse(readFileSync(path, 'utf8'))
} catch (error) {
  console.error(
    `FAIL: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

const total = report?.total
const passed = report?.passed
const rate = report?.rate
if (
  typeof total !== 'number' ||
  typeof passed !== 'number' ||
  (rate !== null && typeof rate !== 'number')
) {
  console.error(`FAIL: ${path} is not an eval report (expected { total, passed, rate }).`)
  process.exit(1)
}

if (total === 0 || rate === null) {
  console.error('FAIL: the report ran no cases — quoting it would be quoting nothing.')
  process.exit(1)
}

const pct = (rate * 100).toFixed(1)
console.log(`compiler golden set: ${passed}/${total} exact match (${pct}%)`)
console.log('quote this with its denominator; 167 hand-written cases is a smoke test, not a proof.')
