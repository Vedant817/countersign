/**
 * QA-env-1: `parseEnv` handed the whole of `process.env` to a `.strict()` schema, so any unrelated
 * variable in a developer's shell stopped the server booting, and the error enumerated eighty of
 * their own variables while hiding the real cause.
 *
 * The fix moved strictness from "any unrecognised key" onto "any unrecognised key within two edits
 * of one we read". Both halves of that are pinned here, because the second half is worthless without
 * the first: if a typo of ours passes, the whole change is just a way to lose a safety net.
 */
import { describe, expect, it } from 'vitest'

import { envSchema, ENV_KEYS, parseEnv, parsePartialEnv } from '../src/env'

/**
 * A minimal environment that satisfies every required variable.
 *
 * The required set is **derived** in the test below rather than copied by hand, so a new required
 * variable fails one test with a clear message instead of nine with "Unrecognized key".
 */
const COMPLETE: Record<string, string> = {
  APP_ENV: 'test',
  PUBLIC_BASE_URL: 'https://countersign.test',
  DATABASE_URL: 'postgres://cs:cs@localhost:5432/cs',
  SESSION_SECRET: 's'.repeat(64),
  PAYPAL_ENV: 'sandbox',
  PAYPAL_API_BASE: 'https://api-m.sandbox.paypal.com',
  PAYPAL_CLIENT_ID: 'id',
  PAYPAL_CLIENT_SECRET: 'secret',
  VI_SERVICE_URL: 'http://localhost:8081',
  VI_SERVICE_TOKEN: 't'.repeat(64),
  VI_KEK: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
  VI_ISSUER_KID: 'vi-issuer',
  VI_MERCHANT_KID: 'vi-merchant',
  VI_ISSUER_URL: 'https://issuer.countersign.test',
  VI_AGENT_ISS: 'https://agent.countersign.test',
  GATE_KID: 'gate-1',
  GATE_SIGNING_KEY: 'g'.repeat(64),
}

/** CsError is a plain object with a message field, not an Error subclass, so String(e) is
 * [object Object]. Reading it structurally is the difference between an assertion that checks the
 * diagnosis and one that checks nothing. */
function messageOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e)
    return String((e as { message: unknown }).message)
  return String(e)
}

/** The keys `parseEnv` reported as *missing*, so a test can name one variable instead of matching prose. */
function missingOf(e: unknown): string[] {
  if (typeof e === 'object' && e !== null && 'details' in e) {
    const d = (e as { details: { missing?: string[] } }).details
    return d.missing ?? []
  }
  return []
}

/** The kinds of variables a developer's shell is full of and none of which are ours. */
const SHELL_NOISE = [
  'GIT_BRANCH',
  'USERNAME',
  'SESSIONNAME',
  'Path',
  'ProgramFiles',
  'COMPUTERNAME',
  'npm_config_cache',
  '_',
  'PSModulePath',
  'HOMEDRIVE',
  'NUMBER_OF_PROCESSORS',
  'APPDATA',
  'windir',
  'USERPROFILE',
  'TEMP',
]

describe('parseEnv tolerates a real shell but still refuses a typo of ours', () => {
  it('parses a clean environment', () => {
    const env = parseEnv(COMPLETE)
    expect(env.DATABASE_URL).toBe(COMPLETE['DATABASE_URL'])
  })

  it('env hygiene: every one of fourteen unrelated shell variables is ignored, individually', () => {
    for (const noise of SHELL_NOISE) {
      // Individually, so a failure names the offender instead of "one of fourteen".
      expect(() => parseEnv({ ...COMPLETE, [noise]: 'whatever' }), noise).not.toThrow()
    }
  })

  it('ignores them all at once too', () => {
    const noisy = { ...COMPLETE }
    for (const noise of SHELL_NOISE) noisy[noise] = 'x'
    expect(() => parseEnv(noisy)).not.toThrow()
  })

  it('tolerates a Windows-style capitalised name for a key we read lower-case', () => {
    // `Path`/`Path` vs `PATH` is not a typo, it is the platform.
    expect(() =>
      parseEnv({ ...COMPLETE, database_url: 'ignored, we read DATABASE_URL' }),
    ).not.toThrow()
  })

  it('STILL refuses a one-character typo of a required variable — the strictness is not gone', () => {
    expect(() => parseEnv({ ...COMPLETE, DATABASE_URL: undefined, DATABSE_URL: 'x' })).toThrow(
      /DATABSE_URL/,
    )
  })

  it('names the intended variable, so the fix is a diagnosis and not just a refusal', () => {
    let message = ''
    try {
      parseEnv({ ...COMPLETE, DATABSE_URL: 'x' })
    } catch (e) {
      message = messageOf(e)
    }
    expect(message).toContain('DATABSE_URL')
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('did you mean')
  })

  it('refuses a typo of an optional variable as well', () => {
    expect(() => parseEnv({ ...COMPLETE, OPENAI_API_KY: 'sk-oops' })).toThrow(/OPENAI_API_KY/)
  })

  it('does not mistake ordinary shell variables for near-misses of ours', () => {
    // The distance bound is the whole mechanism. Without it, `GIT_BRANCH` finds `SENTRY_DSN`-shaped
    // neighbours and every developer's machine fails to boot.
    for (const noise of SHELL_NOISE) {
      let threw = false
      try {
        parseEnv({ ...COMPLETE, [noise]: 'x' })
      } catch {
        threw = true
      }
      expect(threw, `${noise} was mistaken for a typo`).toBe(false)
    }
  })

  it('still reports a genuinely missing required variable as missing', () => {
    const partial = { ...COMPLETE }
    delete (partial as Record<string, string | undefined>)['PUBLIC_BASE_URL']
    let missing: string[] = []
    try {
      parseEnv(partial)
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'details' in e) {
        const d = (e as { details: { missing?: string[] } }).details
        missing = d.missing ?? []
      }
    }
    expect(missing.join(',')).toContain('PUBLIC_BASE_URL')
  })

  it('a missing variable is not reported as a typo of some other variable', () => {
    // `PUBLIC_BASE_URL` absent must produce "missing", not "did you mean".
    const partial = { ...COMPLETE }
    delete (partial as Record<string, string | undefined>)['AGENT_SIGNING_KEY']
    let message = ''
    try {
      parseEnv(partial)
    } catch (e) {
      message = messageOf(e)
    }
    expect(message).not.toContain('did you mean')
  })
})

describe('the declared key list is derived, not maintained', () => {
  it('ENV_KEYS is non-empty and sorted', () => {
    expect(ENV_KEYS.length).toBeGreaterThan(20)
    expect([...ENV_KEYS]).toEqual([...ENV_KEYS].sort())
  })

  it('env hygiene: COMPLETE covers exactly the required set, so a new required key fails here', () => {
    // The point of deriving this is that a future required variable breaks ONE test here with a
    // readable message, instead of breaking every case in this file with "Unrecognized key".
    const required = Object.entries(envSchema.shape)
      .filter(([, s]) => !s.isOptional())
      .map(([k]) => k)
      .sort()
    expect(Object.keys(COMPLETE).sort()).toEqual(required)
  })

  it('env hygiene: every key we test for a typo is one the schema actually declares', () => {
    for (const required of Object.keys(COMPLETE)) {
      expect(ENV_KEYS, required).toContain(required)
    }
    // Optional keys we assert typos for must exist too, or the near-miss test below is vacuous.
    expect(ENV_KEYS).toContain('OPENAI_API_KEY')
  })

  it('env hygiene: the whole product boots without an OpenAI key', () => {
    // The model is the one dependency this project is designed to work without (D-018, D-023, and
    // WP-15e's optional `FileDeps.llm`). Making its key required meant nobody without one could run
    // the Gate, the router or the verifier.
    expect(ENV_KEYS).toContain('OPENAI_API_KEY')
    const withoutKey = { ...COMPLETE }
    delete (withoutKey as Record<string, string | undefined>)['OPENAI_API_KEY']
    expect(() => parseEnv(withoutKey)).not.toThrow()
    expect(parseEnv(withoutKey).OPENAI_API_KEY).toBeUndefined()
  })
})

describe('the signing identities are required here exactly as they are in vi-service', () => {
  /**
   * All four reached a signed artefact, and all four used to be defaulted in
   * `apps/vi/src/vi_service/config.py`: `VI_ISSUER_URL` to `https://www.mastercard.com`, so an
   * unconfigured deployment's L1 credential claimed to *be* Mastercard; `VI_AGENT_ISS` to an RFC 2606
   * `.example` host, which can never resolve, so every L3a/L3b it issued was unverifiable; the two
   * kids to invented names that match no JWKS entry. TypeScript already refused the two kids, and the
   * asymmetry is the whole bug: one runtime refused to boot while the other signed.
   */
  const IDENTITIES = ['VI_ISSUER_KID', 'VI_MERCHANT_KID', 'VI_ISSUER_URL', 'VI_AGENT_ISS']

  it('declares all four', () => {
    for (const key of IDENTITIES) expect(ENV_KEYS, key).toContain(key)
  })

  it('refuses to boot when any one of them is missing', () => {
    // One at a time, and named, so a regression says which variable lost its required status rather
    // than "the environment is invalid".
    for (const key of IDENTITIES) {
      const partial = { ...COMPLETE }
      delete (partial as Record<string, string | undefined>)[key]
      let missing: string[] = []
      try {
        parseEnv(partial)
      } catch (e) {
        missing = missingOf(e)
      }
      expect(missing, `${key} must be required, not defaulted`).toContain(key)
    }
  })

  it('rejects a reserved .example/.invalid identity, which can never resolve', () => {
    // The old default slipped past a plain URL check, because it *is* a syntactically valid URL. The
    // TLD is the tell: a token whose `iss` names a reserved host is dead on arrival.
    expect(() =>
      parseEnv({ ...COMPLETE, VI_AGENT_ISS: 'https://agent.countersign.example' }),
    ).toThrow(/\.example/)
    expect(() =>
      parseEnv({ ...COMPLETE, VI_ISSUER_URL: 'https://issuer.countersign.invalid' }),
    ).toThrow(/\.invalid/)
  })

  it('a malformed identity is a CS_VALIDATION, never a raw TypeError out of parseEnv', () => {
    // The reserved-TLD check has to look at the parsed host, so it has to survive a value `.url()`
    // already rejected. If it does not, `new URL()` throws and every caller's `catch (e: CsError)`
    // reads a TypeError with no `code` and no user-safe message.
    for (const bad of ['not a url', '']) {
      let code = ''
      let threw = false
      try {
        parseEnv({ ...COMPLETE, VI_ISSUER_URL: bad })
      } catch (e) {
        threw = true
        if (typeof e === 'object' && e !== null && 'code' in e)
          code = String((e as { code: unknown }).code)
      }
      expect(threw, `${JSON.stringify(bad)} must be refused`).toBe(true)
      expect(code, `${JSON.stringify(bad)} must be refused as CS_VALIDATION`).toBe('CS_VALIDATION')
    }
  })

  it('accepts a real host, and passes it through verbatim', () => {
    const env = parseEnv(COMPLETE)
    expect(env.VI_ISSUER_URL).toBe(COMPLETE['VI_ISSUER_URL'])
    expect(env.VI_AGENT_ISS).toBe(COMPLETE['VI_AGENT_ISS'])
  })
})

describe('a bad URL is a CsError naming the variable, never a raw TypeError', () => {
  /**
   * `PAYPAL_API_BASE`'s EC-ENV-1 refinement used to call `new URL(u)` unguarded. A zod `.refine()` runs
   * even when the `.url()` beside it has already failed, so `parseEnv({ …, PAYPAL_API_BASE: 'nope' })`
   * raised `TypeError [ERR_INVALID_URL]` straight out of `parseEnv`.
   *
   * That breaks the contract this module documents and every caller relies on: `parseEnv` throws a
   * `CsError`, so `apps/worker`'s boot handler can print its `code` and exit 78. A raw `TypeError` gives
   * it a stack trace instead, and the operator is left hunting for a variable name that never appears.
   *
   * This is asserted for every URL-shaped variable rather than only `PAYPAL_API_BASE`, because the flaw
   * is a pattern — any refinement that calls `new URL` will reintroduce it.
   */
  const URL_VARS = [
    'PUBLIC_BASE_URL',
    'PAYPAL_API_BASE',
    'VI_ISSUER_URL',
    'VI_AGENT_ISS',
    'VI_SERVICE_URL',
  ] as const

  for (const key of URL_VARS) {
    it(`${key} with an unparseable value is a CS_VALIDATION CsError`, () => {
      let thrown: unknown
      try {
        parseEnv({ ...COMPLETE, [key]: 'not a url' })
      } catch (cause) {
        thrown = cause
      }
      // The assertion that matters: it is a CsError at all, and not a TypeError from `URL`.
      expect(thrown, `${key} did not throw`).toBeDefined()
      expect(thrown).not.toBeInstanceOf(TypeError)
      expect((thrown as { code?: string }).code).toBe('CS_VALIDATION')
      expect(String((thrown as Error).message)).toContain(key)
    })
  }

  it('PAYPAL_API_BASE still refuses a well-formed URL that is not a sandbox host', () => {
    // The EC-ENV-1 rule is untouched by making it not crash: a valid https URL on the wrong host is still
    // a refusal, which is the case the rule exists for.
    let thrown: unknown
    try {
      parseEnv({ ...COMPLETE, PAYPAL_API_BASE: 'https://api-m.paypal.com' })
    } catch (cause) {
      thrown = cause
    }
    expect((thrown as { code?: string }).code).toBe('CS_VALIDATION')
    expect(String((thrown as Error).message)).toContain('sandbox.paypal.com')
  })
})

describe('parsePartialEnv is unchanged in spirit', () => {
  it('returns issues rather than throwing, so tooling can print them', () => {
    const { env, issues } = parsePartialEnv({ GIT_BRANCH: 'main' })
    // Unrelated variables are not issues.
    expect(issues).toEqual([])
    expect(env).toBeDefined()
  })
})

describe('the error carries a registry code', () => {
  it('a refused environment is CS_VALIDATION, never a raw ZodError', () => {
    let code = ''
    try {
      parseEnv({ ...COMPLETE, DATABSE_URL: 'x' })
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e) {
        code = (e as { code: string }).code
      }
    }
    expect(code).toBe('CS_VALIDATION')
  })
})
