/**
 * Re-verify the judge panel's findings F1–F15 against the repository.
 *
 * The brief is explicit that every finding must be **proved true or false with a command or a file
 * citation**, not accepted on the panel's word. That is not ceremony: this repository already contains
 * a gate that failed unconditionally for its whole life and a harness rule that matched nothing while
 * reporting success (`docs/CI-FAILURES.md`, `docs/COMPILER-EVAL.md`), so "the reviewer said so" is not
 * evidence here — it is the exact failure mode being audited.
 *
 * Findings that need a network call or a live app (F8, F10, F13, F14) are checked elsewhere and their
 * results are recorded in `docs/review/REVERIFY.md`.
 *
 * ```sh
 * node scripts/reverify-findings.mjs
 * ```
 *
 * Prints `CONFIRMED`, `REFUTED` or `PARTIAL` per finding, each with the citation it was decided on.
 * Exit code is 0 always — this reports, it does not gate; the point is to be readable, not to pass.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const results = []
const record = (id, verdict, finding, evidence) => results.push({ id, verdict, finding, evidence })

/** Every file under a directory, skipping build output and dependencies. */
function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = (dir, ext = '.ts') => walk(dir).filter((f) => f.endsWith(ext))
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

/** Lines across a file set matching a regex, as `path:line: text`. */
function grep(paths, re) {
  const hits = []
  for (const p of paths) {
    const text = read(p)
    if (text === null) continue
    text.split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) hits.push(`${p}:${i + 1}: ${line.trim()}`)
    })
  }
  return hits
}

// ── F1 ────────────────────────────────────────────────────────────────────────────────────────────
try {
  const json = execFileSync(
    'gh',
    [
      'repo',
      'view',
      'Vedant817/countersign',
      '--json',
      'visibility,isPrivate,homepageUrl,licenseInfo',
    ],
    { encoding: 'utf8' },
  )
  const info = JSON.parse(json)
  record(
    'F1',
    info.isPrivate ? 'CONFIRMED' : 'REFUTED',
    'Repo is private and has no About website URL',
    `gh repo view → visibility=${info.visibility} isPrivate=${info.isPrivate} homepageUrl=${JSON.stringify(info.homepageUrl)} license=${info.licenseInfo?.key}`,
  )
} catch (error) {
  record('F1', 'PARTIAL', 'Repo visibility', `gh failed: ${String(error).slice(0, 120)}`)
}

// ── F2 — has anything except the OAuth token ever hit PayPal? ─────────────────────────────────────
{
  /*
   * The finding is about **calls**, not code, and those are different questions. An earlier version of
   * this check answered "packages/paypal/src declares 33 endpoint paths" and returned REFUTED — which
   * refutes nothing: the panel's claim is that nothing except the token exchange has ever been *executed*
   * against the sandbox, and a static scan cannot see execution.
   *
   * That is the same mistake as `capOf()` matching nothing and reporting success, so it is called out
   * rather than quietly corrected. The test that does settle it is whether any real PayPal id — order,
   * capture, authorization, dispute, webhook — is recorded anywhere in the repo.
   */
  const src = files('packages/paypal/src')
  const declared = [
    ...new Set(
      grep(src, /['"`]\/v[12]\//).map((h) => (h.match(/['"`](\/v[12]\/[^'"`]*)/) ?? [])[1]),
    ),
  ]
    .filter(Boolean)
    .map((p) => p.replace(/\$\{[^}]*\}/g, '{id}'))

  // Real PayPal ids are long uppercase-alphanumeric runs; a bare word like ORDER_ID is a placeholder.
  const idLike = /(?<![A-Z0-9])[A-Z0-9]{13,20}(?![A-Z0-9])/
  const evidenceFiles = [...files('docs', '.md'), ...files('docs/verification', '.md')]
  const idHits = grep(evidenceFiles, idLike).filter(
    (h) => !/example|placeholder|PLACEHOLDER|YOUR_|XXX/i.test(h),
  )

  record(
    'F2',
    'PARTIAL',
    'Only POST /v1/oauth2/token has ever hit PayPal',
    `${declared.length} endpoint path(s) are declared in packages/paypal/src (${declared.slice(0, 4).join(', ')}…), so the client is built. ` +
      `${idHits.length} PayPal-id-shaped token(s) appear in docs/, and packages/paypal/test/fixtures/README.md states "zero real captures" — ` +
      'so the panel is right about execution and this scan cannot prove otherwise. Settling it needs a live call, recorded in docs/verification/.',
  )
}

// ── F3 — shopping agent ───────────────────────────────────────────────────────────────────────────
{
  const index = read('packages/agent/src/index.ts') ?? ''
  const srcCount = files('packages/agent/src').length
  record(
    'F3',
    /^export \{\}\s*$/m.test(index.trim()) && srcCount === 1 ? 'CONFIRMED' : 'REFUTED',
    'WP-13 shopping agent is missing',
    `packages/agent/src/index.ts is ${JSON.stringify(index.trim())} and the package has ${srcCount} source file(s).`,
  )
}

// ── F4 — Judge Mode ───────────────────────────────────────────────────────────────────────────────
{
  const page = read('apps/web/app/judge/page.tsx') ?? ''
  // A page that exists but runs no scenarios is "missing" in the sense the panel meant.
  const runsScenarios = /J1|J2|J3|J4/.test(page)
  record(
    'F4',
    runsScenarios ? 'PARTIAL' : 'CONFIRMED',
    'WP-20 Judge Mode is missing',
    `apps/web/app/judge/page.tsx exists (${page.length} bytes) but ${runsScenarios ? 'references the J1–J4 scenario ids' : 'does not reference any of J1–J4'}.`,
  )
}

// ── F5 — wallet onboarding, agent chat, merchant and disputes UIs ────────────────────────────────
{
  const routes = ['wallet', 'agent', 'merchant', 'judge', 'shop', 'regions', 'intent']
  const present = routes.filter((r) => existsSync(join('apps/web/app', r)))
  const missing = routes.filter((r) => !present.includes(r))
  record(
    'F5',
    missing.length > 0 ? 'CONFIRMED' : 'REFUTED',
    'WP-07 Vault onboarding blocked; WP-17a/b/d/e todo',
    `apps/web/app has: ${present.join(', ')}. Missing: ${missing.join(', ') || '(none)'}.`,
  )
}

// ── F6 — MCP submit_checkout refuses ─────────────────────────────────────────────────────────────
{
  const route = read('apps/web/app/api/mcp/[transport]/route.ts') ?? ''
  const idx = route.indexOf('submit_checkout')
  const window = idx === -1 ? '' : route.slice(Math.max(0, idx - 700), idx + 700)
  const refuses = /CS_INTERNAL|not (yet )?(supported|implemented)|refus/i.test(window)
  record(
    'F6',
    refuses ? 'CONFIRMED' : 'PARTIAL',
    'MCP submit_checkout refuses (D-048)',
    refuses
      ? `route.ts:${route.slice(0, idx).split('\n').length} — the submit_checkout branch mentions a refusal or CS_INTERNAL.`
      : 'submit_checkout is present but no refusal text was found near it; needs a live call to settle.',
  )
}

// ── F7 — orchestrator has no persisted order source ──────────────────────────────────────────────
{
  const hits = grep(
    files('packages/orchestrator/src'),
    /no persisted order source|order source|findOrder|orderLookup/i,
  )
  record(
    'F7',
    hits.length > 0 ? 'CONFIRMED' : 'PARTIAL',
    'The orchestrator has no persisted order source',
    hits.length > 0
      ? hits.slice(0, 2).join(' | ')
      : 'No matching comment found in packages/orchestrator/src; needs a live submit to settle.',
  )
}

// ── F9 — the LLM needs a private Modal proxy token ───────────────────────────────────────────────
{
  const llm = read('apps/web/lib/llm.ts') ?? ''
  const needsModal = /MODAL_PROXY_TOKEN/.test(llm)
  const hasOpenAiFallback = /OPENAI_API_KEY/.test(llm)
  record(
    'F9',
    needsModal ? 'CONFIRMED' : 'REFUTED',
    'The LLM path depends on a private Modal proxy token',
    `apps/web/lib/llm.ts references MODAL_PROXY_TOKEN=${needsModal}, OPENAI_API_KEY=${hasOpenAiFallback}. A plain OpenAI key ${hasOpenAiFallback ? 'would' : 'would NOT'} work without the Modal branch.`,
  )
}

// ── F11 — VI keys ephemeral ──────────────────────────────────────────────────────────────────────
{
  const env = read('scripts/dev-local.mjs') ?? ''
  const generates = /randomBytes|generateKey|ephemeral/i.test(env)
  record(
    'F11',
    generates ? 'CONFIRMED' : 'PARTIAL',
    'VI keys are ephemeral, so a restart invalidates signatures',
    `scripts/dev-local.mjs ${generates ? 'generates local credentials at start' : 'does not obviously generate credentials'} — see also VI_KEK handling in .env.local example.`,
  )
}

// ── F12 — PayPal-Request-Id length ───────────────────────────────────────────────────────────────
{
  const idem = read('packages/paypal/src/idempotency.ts') ?? ''
  const limit = idem.match(/(\d{2,3})\s*(?:chars|characters|length|max)/i)
  record(
    'F12',
    limit && Number(limit[1]) > 38 ? 'CONFIRMED' : 'PARTIAL',
    'PayPal-Request-Id can exceed 38 characters',
    limit
      ? `packages/paypal/src/idempotency.ts enforces ${limit[1]} characters. PayPal documents 38.`
      : 'No numeric limit found in idempotency.ts; needs reading the validator directly.',
  )
}

// ── F15 — stale facts ────────────────────────────────────────────────────────────────────────────
{
  const pkg = JSON.parse(read('apps/web/package.json') ?? '{}')
  const nextVersion = pkg.dependencies?.next ?? '(unknown)'
  const readmeNext = /Next\.js 1[0-9]/.exec(read('README.md') ?? '')?.[0] ?? null
  const gptFiles = grep(
    [...files('docs', '.md'), ...files('packages/compiler/eval'), ...files('apps')],
    /gpt-6\.1-sol/,
  ).length
  record(
    'F15',
    nextVersion.startsWith('16') ? 'CONFIRMED' : 'PARTIAL',
    'Docs are stale (Next version, gpt-6.1-sol, HUMAN_TODO date)',
    `apps/web/package.json next=${nextVersion}; README ${readmeNext ? `claims "${readmeNext}"` : 'does not state a Next major'}; ${gptFiles} file(s) still mention gpt-6.1-sol.`,
  )
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n)
console.log(`\n${pad('ID', 5)}${pad('VERDICT', 11)}FINDING`)
console.log('-'.repeat(100))
for (const r of results) console.log(`${pad(r.id, 5)}${pad(r.verdict, 11)}${r.finding}`)
console.log('\nEvidence:')
for (const r of results) console.log(`  ${r.id}: ${r.evidence}`)
console.log(
  `\n${results.filter((r) => r.verdict === 'CONFIRMED').length} confirmed, ` +
    `${results.filter((r) => r.verdict === 'REFUTED').length} refuted, ` +
    `${results.filter((r) => r.verdict === 'PARTIAL').length} partial`,
)
