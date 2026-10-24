/**
 * Report which `.env.local` keys are present and non-empty — **never their values**.
 *
 * Written after a `/status` probe reported `PAYPAL_CLIENT_ID: false` while the credential was known to
 * work, and the question "is the file wrong or is the server stale?" could not be answered from the
 * repo. `node scripts/env-report.mjs` answers it: it reads the file the launcher reads, lists keys, and
 * prints only lengths.
 *
 * A length is safe to print and a value is not, so a personal-access token is reported as `42 chars`
 * rather than as itself. Key *names* are printed because they are the thing being debugged.
 */
import { readFileSync } from 'node:fs'

const ENV_PATH = '.env.local'

/**
 * Keys whose value is safe to print because it is configuration, not a credential.
 *
 * **An allowlist, not a blocklist.** The first version hid values whose *name* looked secret
 * (`SECRET|TOKEN|PASSWORD|KEY|…`) and printed everything else — which put `PAYPAL_CLIENT_ID` on screen
 * in full, because "client id" matches none of those words. A name-pattern blocklist cannot be right:
 * it has to anticipate every name a secret might have, and it only takes one miss to leak. Naming the
 * ~15 keys that are genuinely public inverts the failure — a new credential is hidden until somebody
 * deliberately adds it here.
 */
const PUBLIC_KEYS = new Set([
  'APP_ENV',
  'NODE_ENV',
  'PUBLIC_BASE_URL',
  'VI_SERVICE_URL',
  'VI_ISSUER_KID',
  'VI_MERCHANT_KID',
  'VI_ISSUER_URL',
  'VI_AGENT_ISS',
  'VI_CLOCK_SKEW_SECONDS',
  'GATE_KID',
  'OPENAI_BASE_URL',
  'LLM_MAIN_MODEL',
  'LLM_CHEAP_MODEL',
  'PAYPAL_ENV',
  'PAYPAL_API_BASE',
  'PAYPAL_MCP_URL',
  'PAYPAL_MCP_MODE',
  'CHECKOUT_PRICE_LOCK_SECONDS',
  'FEATURE_BRYNTUM',
  'FEATURE_WEBAUTHN',
  'FEATURE_JUDGE_MODE',
  'RETENTION_DAYS_OPERATIONAL',
  'RETENTION_DAYS_EVIDENCE',
  'LOG_LEVEL',
  'SIGNING_LAB_ENABLED',
  'COUNTERSIGN_VI_PORT',
  'COUNTERSIGN_WEB_PORT',
  'MERCHANT_ID',
  'MERCHANT_NAME',
  'MERCHANT_WEBSITE',
])

let raw
try {
  raw = readFileSync(ENV_PATH, 'utf8')
} catch {
  console.log(`${ENV_PATH} does not exist.`)
  process.exitCode = 1
  process.exit()
}

/** Parse the subset of dotenv syntax the launcher writes: `KEY=value`, `#` comments, optional quotes. */
const entries = []
for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  let value = trimmed.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  entries.push({ key, value })
}

const empty = entries.filter((e) => e.value === '')
const filled = entries.filter((e) => e.value !== '')

console.log(
  `${ENV_PATH}: ${entries.length} keys, ${filled.length} with a value, ${empty.length} empty\n`,
)

console.log('EMPTY (these block whatever needs them):')
if (empty.length === 0) console.log('  (none)')
for (const { key } of empty) console.log(`  ${key}`)

console.log('\nSET:')
for (const { key, value } of filled) {
  // Everything not on the public allowlist is reported as its length and nothing else, so a novel
  // credential is hidden by default rather than by remembering to add it to a blocklist.
  const shown = PUBLIC_KEYS.has(key) ? value : `${value.length} chars`
  console.log(`  ${key} = ${shown}`)
}
console.log(
  `\n${filled.length - filled.filter((e) => PUBLIC_KEYS.has(e.key)).length} value(s) hidden by length. ` +
    'Add a genuinely public key to PUBLIC_KEYS to see it.',
)
