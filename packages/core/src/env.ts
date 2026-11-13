/**
 * Environment validation — spec §6.
 *
 * "All of these are validated at boot by `packages/core/env.ts` (zod). The process MUST refuse to
 * start if any required variable is missing."
 *
 * Two rules that are not obvious and matter a lot:
 *
 *  1. **EC-ENV-1: `PAYPAL_ENV` must not be `live`.** A demo that accidentally takes real money is
 *     the worst possible failure, so `live` is rejected at boot rather than merely unused, and the
 *     API base must be a `*.sandbox.paypal.com` host. We do not support live mode (spec §2).
 *  2. Secrets are only ever read from env vars and are redacted from every log line and error
 *     `details` (spec §8.0 rule "Never commit secrets"; EC-PRIV-3).
 */
import { z } from 'zod'

import { isCsErrorCode, csError, type CsError } from './errors'
import { isCurrency } from './money'

const REDACTED = '[redacted]'

/** Env var names whose *values* must never appear in a log, an error, or an HTTP response body. */
export const SECRET_ENV_KEYS = [
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_ACCESS_TOKEN',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_BUYER_PASSWORD',
  'MERCHANT_PASSWORD',
  'SESSION_SECRET',
  'VI_SERVICE_TOKEN',
  'VI_KEK',
  'GATE_SIGNING_KEY',
  'BRYNTUM_NPM_TOKEN',
  'SENTRY_DSN',
  'DATABASE_URL',
] as const

export type SecretEnvKey = (typeof SECRET_ENV_KEYS)[number]

/** A 32-byte key, base64 (standard or url-safe). */
const base64Key = z.string().refine((s) => {
  try {
    const b = Buffer.from(s, 'base64')
    return b.length === 32
  } catch {
    return false
  }
}, 'must be a base64-encoded 32-byte key')

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  )

/** The RFC 2606 TLDs that can never resolve. `.test` is deliberately absent — it is the conventional
 * fixture host this repository already uses everywhere. */
const RESERVED_IDENTITY_TLD = /\.(example|invalid)$/i

/**
 * Does this string's **host** sit on a reserved, unresolvable TLD?
 *
 * Written with a `try` rather than inline `new URL(...)` because a zod refinement runs even when the
 * `.url()` check beside it already failed — so a malformed value would raise `TypeError [ERR_INVALID_URL]`
 * straight out of `parseEnv` instead of the `CsError` every caller is written to catch. Returning
 * `false` there keeps the diagnosis with `.url()`, which already rejects it with a proper message.
 */
function hasReservedIdentityHost(value: string): boolean {
  try {
    return RESERVED_IDENTITY_TLD.test(new URL(value).hostname)
  } catch {
    return false
  }
}

/**
 * The hostname of an absolute URL, or `null` when `URL` will not parse it.
 *
 * The same reason {@link hasReservedIdentityHost} catches: a zod `.refine()` runs even when the `.url()`
 * check beside it has already failed, so any refinement that calls `new URL` unguarded turns a bad
 * variable into a raw `TypeError` out of `parseEnv` instead of the `CsError` naming the variable. This is
 * the shared helper so every refinement in this file parses the same way.
 */
function parseHost(value: string): string | null {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

/**
 * A signing identity — an absolute URL a real deployment can resolve.
 *
 * A reserved host is rejected rather than left to the operator, because it is not a near miss: the
 * `iss` of every L1, L3a and L3b would name a host that does not exist, so each of those artefacts
 * would be dead on arrival while the service reported success.
 */
const issuerIdentity = z
  .string()
  .url()
  .refine((u) => !hasReservedIdentityHost(u), {
    message:
      'must not be a reserved .example/.invalid host — it can never resolve, so every token carrying it is unverifiable',
  })

/**
 * The full env schema. `APP_ENV` is not optional: a misconfigured deployment should fail loudly at
 * boot rather than behave like production while thinking it is local.
 */
export const envSchema = z
  .object({
    APP_ENV: z.enum(['local', 'render', 'ci', 'test']),
    PUBLIC_BASE_URL: z
      .string()
      .url()
      .refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
        message:
          'PUBLIC_BASE_URL must be https (or localhost) — it appears in evidence packets and QR codes',
      }),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32, 'iron-session needs 32+ characters'),

    /**
     * The merchant's password, read **only** by `pnpm db:seed` (D-059).
     *
     * It is optional and an empty value is treated as unset: a deployment with no `MERCHANT_PASSWORD` has
     * no password login at all, and the seed leaves `users.password_hash` null rather than storing a hash of
     * the empty string. It is declared here so a typo (`MERCHANT_PASS`) is caught by the same near-miss check
     * as every other variable, and so `/status` can say whether sign-in is configured rather than leaving an
     * operator to read the seed script.
     */
    MERCHANT_PASSWORD: z.string().optional(),

    /**
     * EC-ENV-1. A demo that accidentally takes real money is the worst failure available, so `live`
     * is rejected as an *invalid value* with an explanatory message rather than accepted and
     * ignored. The payoff is that `pnpm --filter @countersign/paypal test` can assert on this.
     */
    PAYPAL_ENV: z.literal('sandbox', {
      error: (iss) =>
        iss.input === undefined
          ? 'PAYPAL_ENV is required and must be "sandbox" (EC-ENV-1)'
          : 'EC-ENV-1: PAYPAL_ENV must be "sandbox". This project does not support live mode; ' +
            'live merchant-initiated vault charges also need PayPal approval (spec §2, §12.12).',
    }),
    PAYPAL_API_BASE: z
      .string()
      .url()
      // `hasReservedIdentityHost`-style guard: a `.refine()` runs even when the `.url()` beside it has
      // already failed, so `new URL(u)` here would throw a raw `TypeError [ERR_INVALID_URL]` straight out
      // of `parseEnv` — breaking the contract that it throws a `CsError` and never a raw error, and
      // crashing boot with a stack trace instead of naming the variable. `parseHost` returns `null` for
      // anything `URL` rejects, and a `null` hostname simply fails this refinement.
      .refine(
        (u) => {
          const host = parseHost(u)
          return host !== null && (/(^|\.)sandbox\.paypal\.com$/.test(host) || host === 'localhost')
        },
        {
          message: 'EC-ENV-1: PAYPAL_API_BASE must point at a *.sandbox.paypal.com host',
        },
      ),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
    PAYPAL_WEBHOOK_ID: z.string().default(''),
    PAYPAL_BUYER_EMAIL: z.string().email().optional(),
    PAYPAL_MCP_URL: z.string().url().default('https://mcp.sandbox.paypal.com/http'),
    PAYPAL_MCP_MODE: z.enum(['remote', 'local']).default('remote'),

    /**
     * Optional, and deliberately so.
     *
     * It was required, and **nothing in the repository reads it** — the drafter and the agent take a
     * model through dependency injection, not through the environment. The practical cost was that
     * `parseEnv` refused every process without it, so the whole project refused to boot without an
     * OpenAI key, and the deterministic half of the product — the Gate, the router, the compiler's
     * read-back, the order path, the public verifier — could not be demonstrated by anyone who did not
     * have one. A model is the one dependency this project is explicitly designed to work without:
     * WP-15e's `FileDeps.llm` is optional and `templateNote()` passes the citation checker by
     * construction.
     *
     * So the key is read where a model is actually constructed, and `/status` reports its absence as
     * "not configured" rather than treating it as a boot failure.
     */
    OPENAI_API_KEY: z.string().min(1).optional(),
    /**
     * Where the OpenAI-compatible API lives. Defaults to OpenAI itself.
     *
     * **Why this exists.** A demo that requires a paid key to show a compiler is a demo most people
     * cannot run, and this project's LLM is the one dependency it is designed to work without
     * (§8.0 rule 4). Every provider below speaks the same `/v1/chat/completions` protocol, so a base
     * URL is all that is needed to move between them:
     *
     *   - `https://api.openai.com/v1`                        — OpenAI (paid)
     *   - `https://api.groq.com/openai/v1`                   — Groq (generous free tier, fast)
     *   - `https://openrouter.ai/api/v1`                     — OpenRouter (free models marked `:free`)
     *   - `https://generativelanguage.googleapis.com/v1beta/openai` — Google AI Studio (free tier)
     *   - `https://api.together.xyz/v1`                      — Together
     *   - `http://127.0.0.1:11434/v1`                        — Ollama, fully local, no key at all
     *   - `https://api.modal.com/v1`                         — Modal, if the endpoint is OpenAI-shaped
     *
     * A **local** Ollama needs no `OPENAI_API_KEY`; set it to any non-empty string so
     * `openaiConfigured` reads true, or leave both unset and the deterministic paths still work.
     *
     * Validated as a URL rather than a string so a typo (`api.groq.com` with no scheme) fails at boot
     * instead of as an opaque `fetch` error the first time a judge compiles an intent.
     */
    OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    /*
     * No default, deliberately.
     *
     * These used to default to `gpt-6.1-sol` and `gpt-6-luna`, which are the spec's *illustrative* model
     * names from AT-M8.1 — transcribed into a runtime default. A default model id is wrong in principle,
     * not merely wrong in value: `OPENAI_BASE_URL` above can point at OpenAI, Groq, OpenRouter, Together,
     * a local Ollama or a Modal endpoint, and every one of them uses different model ids. Any literal
     * here is a guess that is wrong for most deployments, and it fails as an opaque provider 4xx rather
     * than as "you have not chosen a model".
     *
     * Optional rather than required, following D-053 ("missing configuration is a state, not an
     * exception"): the deterministic paths work with no model at all, and `missingLlmConfig` in
     * `apps/web/lib/llm.ts` reports the absence on `/status` instead of refusing to boot.
     */
    LLM_MAIN_MODEL: z.string().min(1).optional(),
    LLM_CHEAP_MODEL: z.string().min(1).optional(),

    VI_SERVICE_URL: z.string().url(),
    VI_SERVICE_TOKEN: z.string().min(16),
    VI_KEK: base64Key,
    VI_ISSUER_KID: z.string().min(1),
    VI_MERCHANT_KID: z.string().min(1),
    /**
     * The two `iss` identities vi-service signs as, required here for the same reason the Python
     * service requires them (`apps/vi/src/vi_service/config.py::_req`).
     *
     * They are declared rather than defaulted because both were silently defaulted in Python, which
     * is the same bug in two directions: `VI_ISSUER_URL` defaulted to `https://www.mastercard.com`,
     * so an unconfigured deployment's L1 credential claimed to *be* Mastercard, and `VI_AGENT_ISS`
     * defaulted to an RFC 2606 `.example` host, which can never resolve, so every L3a/L3b it issued
     * was unverifiable by construction. TypeScript refusing to boot while Python substituted a
     * placeholder is not a safety property — it is two languages disagreeing about one setting.
     *
     * `.example` and `.invalid` are rejected outright rather than left to the operator: both are
     * reserved and never resolve, so a token carrying one is dead on arrival. `.test` is allowed on
     * purpose — it is the reserved-but-conventional fixture host this repository uses everywhere.
     */
    VI_ISSUER_URL: issuerIdentity,
    VI_AGENT_ISS: issuerIdentity,
    VI_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(3600).default(300),

    GATE_KID: z.string().min(1),
    GATE_SIGNING_KEY: z.string().min(1),

    CHECKOUT_PRICE_LOCK_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    FEATURE_BRYNTUM: boolish.default(false),
    FEATURE_WEBAUTHN: boolish.default(true),
    FEATURE_JUDGE_MODE: boolish.default(true),

    RETENTION_DAYS_OPERATIONAL: z.coerce.number().int().min(1).max(3650).default(365),
    RETENTION_DAYS_EVIDENCE: z.coerce.number().int().min(1).max(3650).default(540),

    SENTRY_DSN: z.string().optional(),

    /**
     * §8.19: the background worker's opt-in health port.
     *
     * **Optional, and that is the point.** Render runs the worker as `type: worker`, which has no port and no
     * health check; the primary liveness signal is `worker_job_runs` read by the web `/status`. This variable
     * exists for the operator who wants a `curl` against the worker itself, and it is off until they ask for it
     * because a listener nobody configured is a listener nobody is watching.
     *
     * Declared here rather than read ad hoc so a typo (`WORKER_HEALTH_PORTS`) is caught by the boot check and
     * by `ENV_KEYS`, instead of silently leaving the endpoint unbound.
     */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    /**
     * The worker's identity in `worker_job_runs.worker_id`.
     *
     * Optional and unbounded on purpose: `apps/worker/src/heartbeat.ts` falls back to `hostname-pid` and
     * treats an empty value as absent, so an operator who leaves the example's `WORKER_ID=` in place gets
     * the fallback rather than a boot failure about a cosmetic setting.
     */
    WORKER_ID: z.string().optional(),
  })
  // NOT `.strict()`. See `parseEnv` for why strictness was removed and what replaced it — the
  // behaviour `.strict()` gave us is preserved where it matters and dropped where it was noise.
  .passthrough()

export type Env = z.infer<typeof envSchema>

/** Every key this project declares. Derived from the schema, so a new variable is never forgotten. */
// Sorted *before* freezing. `Object.freeze(a).sort()` throws — `Array.prototype.sort` writes into the
// receiver, and the receiver is frozen.
export const ENV_KEYS: readonly string[] = Object.freeze(Object.keys(envSchema.shape).sort())

/**
 * Env that is allowed to be absent. Used by tooling (seed, tests, the sandbox probe scripts) that
 * needs a partial environment to do something useful — e.g. `scripts/week1-check-1.ts` needs PayPal
 * credentials but not OpenAI.
 */
export const partialEnvSchema = envSchema.partial()

/**
 * Damerau-Levenshtein distance, capped at 2, so a near-miss is cheap to detect and impossible to
 * report by accident.
 *
 * The bound is what makes this usable: a developer's shell holds hundreds of variables
 * (`GIT_BRANCH`, `USERNAME`, `SESSIONNAME`, npm's `_`/`npm_config_*` family), so an unbounded
 * "is this close to one of ours" check finds matches everywhere. Unbounded similarity is worse than
 * none, because it produces a hard error about the wrong variable.
 */
function withinTwoEdits(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  // Anything already more than two apart in length cannot be within two edits.
  if (long.length - short.length > 2) return false
  // `noUncheckedIndexedAccess` is on, so every cell is `number | undefined`. The rows are dense by
  // construction, but a `?? 0` here would be a lie dressed as a default — so the widths are asserted
  // instead and the reads use a helper that cannot return undefined.
  const row = (n: number): number[] => Array.from({ length: n }, (_, i) => i)
  const at = (r: readonly number[], i: number): number => {
    const v = r[i]
    if (v === undefined) throw new Error(`edit-distance row too short at ${i}/${r.length}`)
    return v
  }
  let prev: number[] = row(short.length + 1)
  for (let i = 1; i <= long.length; i += 1) {
    const cur: number[] = [i]
    for (let j = 1; j <= short.length; j += 1) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1
      cur[j] = Math.min(at(cur, j - 1) + 1, at(prev, j) + 1, at(prev, j - 1) + cost)
    }
    prev = cur
    if (Math.min(...cur) > 2) return false
  }
  return at(prev, short.length) <= 2
}

const KNOWN = new Set(ENV_KEYS)

/**
 * Split the keys `parseEnv` does not recognise into **typos we must refuse** and **unrelated shell
 * noise we must ignore**.
 *
 * Returns `null` when nothing needs reporting.
 */
function suspiciousKeys(source: NodeJS.ProcessEnv): { key: string; didYouMean: string }[] | null {
  const suspicious: { key: string; didYouMean: string }[] = []
  for (const key of Object.keys(source)) {
    if (key === '' || KNOWN.has(key)) continue
    // Case is not a typo here: Windows and macOS both populate `Path`/`USERPROFILE`/`TMPDIR` with
    // capitalisation no author would have chosen, and failing boot over that is absurd.
    const upper = key.toUpperCase()
    if (KNOWN.has(upper)) continue
    const near = ENV_KEYS.find((k) => withinTwoEdits(upper, k))
    if (near) suspicious.push({ key, didYouMean: near })
  }
  return suspicious.length > 0 ? suspicious : null
}

function formatIssues(e: z.ZodError): CsError {
  const issues = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }))
  const missing = issues
    .filter((i) => i.code === 'invalid_type' || i.message.includes('Required'))
    .map((i) => i.path)
  return csError(
    'CS_VALIDATION',
    `Invalid environment: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
    { issues, missing },
    { userMessage: 'The server is misconfigured. Please tell the operator.' },
  )
}

/**
 * Parse an env record. Throws a `CsError` (never a raw `ZodError`) so callers can render one
 * consistent message, and lists every offending key at once rather than one per restart.
 *
 * ## Why this is not `.strict()`
 *
 * `.strict()` conflated two failures that deserve opposite answers:
 *
 * | Situation | Correct behaviour | What `.strict()` did |
 * |---|---|---|
 * | `DATABSE_URL` — a typo in one of ours | **refuse to boot.** The variable that was supposed to hold the database password is not holding anything, and the alternative is connecting to nothing with a cheerful log line | refused ✅ |
 * | `GIT_BRANCH`, `USERNAME`, `SESSIONNAME`, `npm_config_*` — the developer's shell | **ignore it.** None of these is ours and none of them is a typo | refused ❌ |
 *
 * The second row is QA-env-1, confirmed by execution: adding `GIT_BRANCH` to an otherwise perfect
 * environment produced `Invalid environment: : Unrecognized key: "GIT_BRANCH"` and the worker
 * refused with exit 78. A developer cannot run the project in a normal shell, and the message
 * enumerates eighty of their own unrelated variables — which hides the one real cause among them.
 *
 * So strictness is **not** simply removed: it is moved onto near-misses. An unrecognised key within
 * two edits of one of ours is a typo and is still a hard error, now with the intended name attached.
 * Everything else is dropped. On Render, where the environment is clean, this changes nothing; in a
 * developer's shell it stops the environment from being an obstacle.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const candidate: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    candidate[k] = v
  }
  const suspicious = suspiciousKeys(source)
  if (suspicious) {
    throw csError(
      'CS_VALIDATION',
      `Invalid environment: ${suspicious
        .map(
          (s) =>
            `${s.key}: unrecognised, and close to ${s.didYouMean} — did you mean ${s.didYouMean}?`,
        )
        .join('; ')}`,
      { suspicious },
      {
        userMessage:
          'The server is misconfigured. A variable looks like a typo of one we do read. Please tell the operator.',
      },
    )
  }
  const result = envSchema.safeParse(candidate)
  if (!result.success) throw formatIssues(result.error)
  return result.data
}

/**
 * Parse a *subset* of the env. Used by CI and scripts that only need some variables. Returns the
 * keys it could not satisfy so the caller can print an actionable message.
 */
export function parsePartialEnv(source: NodeJS.ProcessEnv = process.env): {
  env: Partial<Env>
  issues: { path: string; message: string }[]
} {
  const candidate: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    candidate[k] = v
  }
  const result = partialEnvSchema.safeParse(candidate)
  if (result.success) return { env: result.data, issues: [] }
  return {
    env: {},
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  }
}

let cached: Env | null = null

/**
 * The process-wide validated env. Throws on first use if anything is missing, which is the
 * "refuse to start" behaviour spec §6 requires.
 */
export function env(): Env {
  if (cached) return cached
  cached = parseEnv()
  return cached
}

/** Test helper: install a validated env without touching `process.env`. */
export function setEnvForTesting(value: Env | null): void {
  cached = value
}

export function clearEnvCache(): void {
  cached = null
}

/** A `CsError` for EC-ENV-1, used by the PayPal client as well as by boot. */
export function liveModeRejected(): CsError {
  return csError(
    'CS_VALIDATION',
    'EC-ENV-1: refusing to run against live PayPal. PAYPAL_ENV must be "sandbox" and PAYPAL_API_BASE ' +
      'must be a sandbox host.',
    { ec: 'EC-ENV-1' },
    { userMessage: 'This deployment is not configured for the PayPal sandbox.' },
  )
}

/** EC-ENV-1 guard used anywhere a base URL or env name could arrive at runtime. */
export function assertSandbox(envLike: { PAYPAL_ENV: string; PAYPAL_API_BASE: string }): void {
  if (envLike.PAYPAL_ENV !== 'sandbox') throw liveModeRejected()
  let host: string
  try {
    host = new URL(envLike.PAYPAL_API_BASE).hostname
  } catch {
    throw liveModeRejected()
  }
  if (!/(^|\.)sandbox\.paypal\.com$/.test(host) && host !== 'localhost' && host !== '127.0.0.1') {
    throw liveModeRejected()
  }
}

/** Base64url helpers for the KEK, shared by vi-service and the tools that provision it. */
export function decodeKek(b64: string): Buffer {
  const b = Buffer.from(b64, 'base64')
  if (b.length !== 32) {
    throw csError('CS_VALIDATION', 'VI_KEK must decode to exactly 32 bytes', { bytes: b.length })
  }
  return b
}

export function encodeKek(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64')
}

/** Field names whose **values** are personal data and must not be logged (EC-PRIV-3). */
export const PII_KEYS = [
  'name',
  'display_name',
  'full_name',
  'first_name',
  'last_name',
  'given_name',
  'surname',
  'payer_name',
  'recipient_name',
  'address',
  'address_line_1',
  'address_line_2',
  'street',
  'city',
  'postal_code',
  'postcode',
  'zip',
  'phone',
  'email',
  'email_address',
  'payer_email',
] as const

/**
 * Redact secrets and PII out of an arbitrary object before it goes into a log or an evidence packet.
 *
 * Two independent passes, because they catch different mistakes:
 *  - **credential keys** (`SECRET_ENV_KEYS` and a name pattern): anything under a key that smells
 *    like a secret, at any depth, matched case-insensitively so `clientSecret` and
 *    `PAYPAL_CLIENT_SECRET` are both caught.
 *  - **PII keys** (`PII_KEYS`): the *value* is replaced but the key is kept, so a log line still
 *    shows that a `payer_email` was present — which matters when debugging a wallet flow.
 *
 * Honest limit, stated because the spec's AT-M19.2 asks for "no email or full name" in logs: a
 * regex cannot find a person's name inside a free-text `msg` string, and pretending otherwise
 * would be a false assurance. The discipline that actually holds is "never put a name in the
 * message; put it in a named field", and `PII_KEYS` enforces the second half of that. Message text
 * is scrubbed for emails, card numbers, phone numbers and JWTs by value, which is the honest limit
 * of pattern matching.
 */
export function redact<T>(input: T): T {
  const secretish =
    /(secret|password|token|api[_-]?key|authorization|cookie|\bkek\b|private[_-]?key|access[_-]?token)/i
  const pii = new Set<string>(PII_KEYS.map((k) => k.toLowerCase()))
  const seen = new WeakSet<object>()

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]'
      seen.add(v)
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const present = val !== null && val !== undefined && val !== ''
        if (secretish.test(k) && present) out[k] = REDACTED
        else if (pii.has(k.toLowerCase()) && present) out[k] = '[pii]'
        else out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(input) as T
}

/**
 * Redact a free-text line (a log message, an error message) that may contain a secret value.
 * We scrub any known secret *value* that appears in the text, plus the usual bearer shapes.
 */
export function redactText(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join(REDACTED)
  }
  // Three dot-separated base64url segments of at least 10 chars is the shape of a compact JWS.
  // Kept tight enough that ordinary prose ("e.g. the note.and.the.value") is not mangled.
  out = out.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  return out
}

/**
 * A readiness probe for `/status` (spec §8.19) that never leaks a value: it reports *present* or
 * *missing* per key, plus a currency check for the ones that look like money.
 */
export function envReport(source: NodeJS.ProcessEnv = process.env): {
  present: Record<string, boolean>
  currencyOk: boolean
  sandboxOnly: boolean
} {
  const present: Record<string, boolean> = {}
  for (const key of Object.keys(envSchema.shape)) present[key] = Boolean(source[key])
  return {
    present,
    currencyOk: isCurrency(source['STORE_CURRENCY'] ?? 'USD'),
    sandboxOnly: source['PAYPAL_ENV'] === 'sandbox',
  }
}

export { isCsErrorCode }
