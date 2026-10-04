/**
 * CLI for the schema drift check — spec §8.4 AT-M4.2.
 *
 * ```
 * pnpm --filter @countersign/vi-client schema-drift                       # $VI_SERVICE_URL/openapi.json
 * pnpm --filter @countersign/vi-client schema-drift -- ./openapi.json     # a local file
 * pnpm --filter @countersign/vi-client schema-drift -- http://vi:8000/openapi.json
 * pnpm --filter @countersign/vi-client schema-drift -- --json             # machine-readable
 * ```
 *
 * Exit codes, so CI can tell the three outcomes apart:
 *
 * - **0** — no differences. The zod schemas and the service agree, field for field.
 * - **1** — at least one difference. The table above says which field, on which route, on which side,
 *   and in which direction. This is the failure §8.4 asks for.
 * - **2** — the document could not be read or is not JSON. Deliberately *not* 1: "I could not check"
 *   must never look like "I checked and it was fine", and a CI job that treats 2 as a soft pass is the
 *   difference between a gate and a decoration.
 *
 * This is a `console` CLI by design: `console.log` is the point. (`eslint.config.mjs` turns `no-console`
 * off under `scripts/`, and this file opts out of the rule at the top rather than being special-cased
 * in the shared config.)
 */
/* eslint-disable no-console */
import { compareSchemas, formatDriftTable, hasDrift, loadOpenApiDocument } from './schema-drift'

const USAGE = `schema-drift — compare vi-service's /openapi.json against packages/vi-client's zod schemas (spec §8.4 AT-M4.2)

  schema-drift [<url|path>] [--json]

  <url|path>   an http(s) URL or a local file path. Defaults to $VI_SERVICE_URL + /openapi.json.

Exit codes: 0 no differences · 1 differences found · 2 the document could not be read`

async function main(argv: readonly string[]): Promise<number> {
  const asJson = argv.includes('--json')
  const positional = argv.filter((a) => !a.startsWith('--'))
  // Built here rather than as `env?.replace(...) + '/openapi.json'`, which would produce the literal string
  // "undefined/openapi.json" when the variable is unset and force a sentinel comparison downstream.
  const baseUrl = process.env['VI_SERVICE_URL']?.replace(/\/+$/, '')
  const source = positional[0] ?? (baseUrl !== undefined ? `${baseUrl}/openapi.json` : undefined)

  if (source === undefined) {
    console.error(USAGE)
    console.error('\nerror: no document source. Pass one, or set VI_SERVICE_URL.')
    return 2
  }

  let document: unknown
  try {
    document = await loadOpenApiDocument(source)
  } catch (e) {
    console.error(USAGE)
    console.error(`\nerror: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  const report = compareSchemas(document)

  if (asJson) {
    console.log(JSON.stringify({ source, ...report }, null, 2))
  } else {
    console.log(`source: ${source}`)
    console.log(formatDriftTable(report))
  }

  return hasDrift(report) ? 1 : 0
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 2
  })
