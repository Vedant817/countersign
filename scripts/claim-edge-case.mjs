/**
 * Promote an edge case to `done` once its handling has been verified against the code.
 *
 * ```sh
 * node scripts/claim-edge-case.mjs EC-IDEM-4 --evidence "packages/orders/src/refund-reservation.ts:39-53"
 * ```
 *
 * ## Why this is a script and not a text edit
 *
 * `docs/edge-cases.json` is the input to `scripts/gen-edge-cases.mjs`, and `pnpm test:ec` fails the build
 * while any case is `todo` with no referencing test. Editing the JSON by hand is how a case acquires a
 * status nobody re-checked — so the evidence for the promotion is **recorded in the same write** as the
 * status, and cannot be omitted.
 *
 * The evidence is required, not optional. A promotion without it is exactly the unverifiable claim this
 * whole mechanism exists to prevent.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const id = argv.find((a) => !a.startsWith('--'))
const evidenceFlag = argv.indexOf('--evidence')
const evidence = evidenceFlag === -1 ? null : argv[evidenceFlag + 1]

if (!id) {
  console.error(
    'usage: node scripts/claim-edge-case.mjs <EC-ID> --evidence "<file:lines or test name>"',
  )
  process.exit(2)
}
if (!evidence) {
  console.error(
    'refusing to promote without --evidence.\n' +
      '  A status of "done" with nothing pointing at the handling is indistinguishable from a guess,\n' +
      '  which is what `pnpm test:ec` exists to catch.',
  )
  process.exit(2)
}

const path = 'docs/edge-cases.json'
const doc = JSON.parse(readFileSync(path, 'utf8'))
const cases = doc.cases ?? doc
const target = cases.find((c) => c.id === id)

if (!target) {
  console.error(`${id} is not in ${path}. Ids do not get invented.`)
  process.exit(1)
}

console.log(`${id}: ${target.status ?? '(no status)'} → done`)
console.log(`  handling: ${target.handling}`)
console.log(`  evidence: ${evidence}`)

target.status = 'done'
target.verifiedBy = evidence
writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
console.log(`\nwrote ${path}. Run \`pnpm test:ec\` to confirm the count moved.`)
