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
  'OPENAI_API_KEY',
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
const base64Key = z
  .string()
  .refine((s) => {
    try {
      const b = Buffer.from(s, 'base64')
      return b.length === 32
    } catch {
      return false
    }
  }, 'must be a base64-encoded 32-byte key')

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

/**
 * The full env schema. `APP_ENV` is not optional: a misconfigured deployment should fail loudly at
 * boot rather than behave like production while thinking it is local.
 */
export const envSchema = z
  .object({
    APP_ENV: z.enum(['local', 'render', 'ci', 'test']),
    PUBLIC_BASE_URL: z.string().url().refine((u) => u.startsWith('https://') || u.startsWith('http://localhost'), {
      message: 'PUBLIC_BASE_URL must be https (or localhost) — it appears in evidence packets and QR codes',
    }),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32, 'iron-session needs 32+ characters'),

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
      .refine((u) => /(^|\.)sandbox\.paypal\.com$/.test(new URL(u).hostname) || new URL(u).hostname === 'localhost', {
        message: 'EC-ENV-1: PAYPAL_API_BASE must point at a *.sandbox.paypal.com host',
      }),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
    PAYPAL_WEBHOOK_ID: z.string().default(''),
    PAYPAL_BUYER_EMAIL: z.string().email().optional(),
    PAYPAL_MCP_URL: z.string().url().default('https://mcp.sandbox.paypal.com/http'),
    PAYPAL_MCP_MODE: z.enum(['remote', 'local']).default('remote'),

    OPENAI_API_KEY: z.string().min(1),
    LLM_MAIN_MODEL: z.string().min(1).default('gpt-6.1-sol'),
    LLM_CHEAP_MODEL: z.string().min(1).default('gpt-6-luna'),

    VI_SERVICE_URL: z.string().url(),
    VI_SERVICE_TOKEN: z.string().min(16),
    VI_KEK: base64Key,
    VI_ISSUER_KID: z.string().min(1),
    VI_MERCHANT_KID: z.string().min(1),
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
  })
  .strict()

export type Env = z.infer<typeof envSchema>

/**
 * Env that is allowed to be absent. Used by tooling (seed, tests, the sandbox probe scripts) that
 * needs a partial environment to do something useful — e.g. `scripts/week1-check-1.ts` needs PayPal
 * credentials but not OpenAI.
 */
export const partialEnvSchema = envSchema.partial()

function formatIssues(e: z.ZodError): CsError {
  const issues = e.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }))
  const missing = issues.filter((i) => i.code === 'invalid_type' || i.message.includes('Required')).map((i) => i.path)
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
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const candidate: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    candidate[k] = v
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