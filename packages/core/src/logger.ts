/**
 * Structured logger — spec §8.19 M19 ("pino JSON with `request_id`, `paypal_debug_id`,
 * `attempt_id`; PII redaction list").
 *
 * Pinned to Node's built-in structured logging so there is no extra dependency in the trust path,
 * and every line goes through {@link redact} + {@link redactText} before it is written. The
 * redaction test in AT-M19 ("Logs contain no email or full name") asserts against this module.
 */
import { redact, redactText, SECRET_ENV_KEYS } from './env'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerFields {
  request_id?: string
  attempt_id?: string
  paypal_debug_id?: string
  [key: string]: unknown
}

export interface LogSink {
  write(line: string): void
}

export interface Logger {
  debug(msg: string, fields?: LoggerFields): void
  info(msg: string, fields?: LoggerFields): void
  warn(msg: string, fields?: LoggerFields): void
  error(msg: string, fields?: LoggerFields): void
  child(fields: LoggerFields): Logger
}

function resolveLevel(): LogLevel {
  const v = (process.env['LOG_LEVEL'] ?? '').toLowerCase()
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v
  return process.env['NODE_ENV'] === 'test' ? 'error' : 'info'
}

/**
 * Every log line passes through three independent filters, because each catches a different
 * mistake (spec §8.19, EC-PRIV-3):
 *
 *  1. `redact` — **key-name** matching. Any value under a credential-looking key becomes
 *     `[redacted]`; any value under a PII key (`display_name`, `payer_email`, `address`, …) becomes
 *     `[pii]` while the key itself stays, so the log still proves a wallet field was present.
 *  2. `redactText` — **known-value** matching. Every secret currently in the environment is scrubbed
 *     out of free text, plus compact-JWS and `Bearer …` shapes.
 *  3. `scrubPii` — **shape** matching in the message and in string fields: emails, card numbers and
 *     phone numbers.
 *
 * Deliberate non-goal: catching a person's *name* inside free text. No regex can do that honestly,
 * and claiming otherwise would be a false assurance. The rule for callers is "put names in a named
 * field, never in the message string", and filter 1 is what makes that rule enforceable.
 */
export const SECRET_KEYS = SECRET_ENV_KEYS

export const PII_PATTERNS: { name: string; re: RegExp; replace: string }[] = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: '[email]' },
  // Separators must sit *between* digits; a trailing `[ -]?` would swallow the space after the
  // number and mangle the surrounding sentence.
  { name: 'pan', re: /\b\d(?:[ -]?\d){12,18}\b/g, replace: '[card]' },
  { name: 'phone', re: /\+?\d(?:[ -]?\d){8,14}\b/g, replace: '[phone]' },
]

/** Apply the PII value patterns to a string. */
export function scrubPii(text: string): string {
  let out = text
  for (const p of PII_PATTERNS) out = out.replace(p.re, p.replace)
  return out
}

export function createLogger(opts: {
  level?: LogLevel
  base?: LoggerFields
  sink?: LogSink
  /** Concrete secret values to scrub out of free text (env values). */
  secrets?: (string | undefined)[]
} = {}): Logger {
  const level = opts.level ?? resolveLevel()
  const base = opts.base ?? {}
  const secrets = opts.secrets ?? SECRET_ENV_KEYS.map((k) => process.env[k])
  const sink: LogSink = opts.sink ?? { write: (line) => process.stdout.write(`${line}\n`) }

  const emit = (lvl: LogLevel, msg: string, fields?: LoggerFields) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return
    const merged = redact({ ...base, ...(fields ?? {}) }) as LoggerFields
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: scrubPii(redactText(msg, secrets)),
      ...Object.fromEntries(
        Object.entries(merged).map(([k, v]) => [
          k,
          typeof v === 'string' ? scrubPii(redactText(v, secrets)) : v,
        ]),
      ),
    }
    sink.write(JSON.stringify(line))
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, sink, secrets }),
  }
}

/** The default process logger. Apps create a `child()` with their request id. */
export const logger = createLogger()