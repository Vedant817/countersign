import 'server-only'

/**
 * The Gate's production composition root — the call site `packages/gate` has never had.
 *
 * ## Why this file is the whole point
 *
 * The project's invariant I-1 is "no PayPal order without an `ALLOW` from a deterministic Gate". Until
 * now that sentence was true only of the orchestrator's own test suite: no app imported `gate`, so
 * nothing in the product could take a decision, and `gate_decisions` had a writer with no caller. A
 * Gate that cannot be reached is a library, not a control.
 *
 * ## What it composes, and what it refuses to invent
 *
 * `gateDepsFromRepos` wants seventeen members. Fifteen come straight from `@countersign/db`. Two do
 * not, and both are composed here rather than papered over:
 *
 *  - **`vi`** is an injected `ViClient`. `@countersign/vi-client` is not in `packages/gate`'s manifest
 *    (contract issue #8), so the Gate cannot build one; this file can, and does — but only when
 *    `VI_SERVICE_URL` and `VI_SERVICE_TOKEN` are set, because check 4 with no verifier is not a Gate.
 *  - **`signRecord`** needs the Gate's private key. Without `GATE_SIGNING_KEY` there is nothing to
 *    sign a decision with, and an unsigned decision record is exactly the fabrication D-039 exists to
 *    prevent. So a missing key is a **refusal**, not a default.
 *
 * ## Why the refusal is a `Result` and not a throw
 *
 * A judge running this locally has no PayPal and may have no VI. The honest answer to
 * `POST /api/gate/evaluate` in that state is a sentence naming what is missing, not a stack trace —
 * the same rule `/v/<packetId>` now follows (D-053). Everything below returns `Result`, and the route
 * maps `CS_INTERNAL`/`CS_VALIDATION` onto a `CsErrorBody` (AGENTS.md rule 3).
 *
 * ## The transaction bridge
 *
 * `@countersign/db`'s `withTx` commits when its callback resolves and knows nothing about the Gate's
 * rollback signal; the Gate's `transaction` handle is required to honour it. Bridging them is the only
 * place the two meet, and it is why a `BLOCK` on check 9 cannot leave check 8's reservation committed —
 * the leak AT-M10.4 rules out. `withShopTransaction` solved the same problem for the merchant port by
 * throwing; this bridge is the same idea expressed as a signal the Gate already understands.
 */
import { csError, systemClock, type CsError, type Result } from '@countersign/core'
import * as repository from '@countersign/db'
import { db, jwksKeys, type Exec } from '@countersign/db'
import {
  gateDepsFromRepos,
  merchantKeySetFromJwks,
  recordSigner,
  type GateDeps,
  type GateRepoHandles,
  type MerchantKeySet,
} from '@countersign/gate'
import { ViClient } from '@countersign/vi-client'

/**
 * `packages/gate`'s rollback signal, declared structurally.
 *
 * `TxControl` lives in `packages/gate/src/deps.ts` and is not re-exported from the package barrel, so
 * the shape is restated here rather than reached into with a deep import. It is two members and both
 * are load-bearing: `rollback` is how check 9 abandons check 8's reservation, and `rolledBack` is how
 * the bridge below knows it happened.
 */
export interface TxControl {
  rollback(reason: string): void
  readonly rolledBack: boolean
}

/** Why the Gate cannot run, if it cannot. */
export interface GateRuntimeUnavailable {
  readonly missing: readonly string[]
  readonly detail: string
}

/** The Gate's configuration, read once per call rather than at import (D-053's lesson). */
const REQUIRED_GATE_ENV = [
  'DATABASE_URL',
  'VI_SERVICE_URL',
  'VI_SERVICE_TOKEN',
  'GATE_SIGNING_KEY',
] as const

export function missingGateEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly (typeof REQUIRED_GATE_ENV)[number][] {
  return REQUIRED_GATE_ENV.filter((name) => {
    const value = env[name]
    return value === undefined || value.trim() === ''
  })
}

/**
 * The Gate's signing key, parsed from the JSON JWK in `GATE_SIGNING_KEY`.
 *
 * ## Ed25519, not ES256
 *
 * `signDecisionRecord` sets `alg: 'EdDSA'` (`packages/gate/src/decision-record.ts:258`), so the key
 * must be an **Ed25519/OKP** JWK. An EC P-256 key imports cleanly and then fails at the first
 * `sign()`, because jose validates the algorithm against the key type — which is precisely how this
 * was found: the route answered *"Could not sign the Gate decision record"* on a live request rather
 * than at startup. The `kty`/`crv` check below is what turns that into a configuration error the
 * operator can read.
 *
 * Parsing is validated rather than assumed for the same reason: a truncated or mistyped key would
 * otherwise surface as an opaque WebCrypto failure at the moment a decision is signed, which is the
 * worst possible time.
 */
async function importSigningKey(jwkJson: string): Promise<CryptoKey> {
  let parsed: unknown
  try {
    parsed = JSON.parse(jwkJson)
  } catch {
    throw csError('CS_VALIDATION', 'GATE_SIGNING_KEY is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw csError('CS_VALIDATION', 'GATE_SIGNING_KEY is not a JWK object')
  }
  const jwk = parsed as Record<string, unknown>
  if (jwk['kty'] !== 'OKP' || jwk['crv'] !== 'Ed25519') {
    throw csError(
      'CS_VALIDATION',
      'GATE_SIGNING_KEY must be an Ed25519 (OKP/Ed25519) private JWK: the decision record is signed ' +
        `with EdDSA, so a ${String(jwk['kty'] ?? 'missing')}/${String(jwk['crv'] ?? 'missing')} key cannot sign it`,
    )
  }
  return crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'Ed25519' }, false, ['sign'])
}

/**
 * The Gate's transaction handle, over `@countersign/db`'s.
 *
 * `repository.withTx` resolves to a `Result`; the Gate's contract is a plain promise plus a rollback
 * signal. Both differences are handled here so neither leaks into `packages/gate`:
 *  - a callback that reported `rollback` is turned into a thrown error, which is the only way to stop
 *    the repository's commit from happening; and
 *  - the repository's own `err` is thrown rather than returned, so a database failure cannot be
 *    mistaken for a Gate verdict.
 */
function gateTransaction<T>(fn: (exec: Exec, control: TxControl) => Promise<T>): Promise<T> {
  return repository
    .withTx(async (tx) => {
      let rolledBack = false
      let reason = ''
      const control: TxControl = {
        rollback(why: string) {
          rolledBack = true
          reason = why
        },
        get rolledBack() {
          return rolledBack
        },
      }
      const value = await fn(tx as unknown as Exec, control)
      if (rolledBack) throw new Error(reason === '' ? 'the Gate rolled back' : reason)
      return value
    })
    .then((result) => {
      if (!result.ok) throw result.error
      return result.value
    })
}

/**
 * Build the Gate's deps, or say what is missing.
 *
 * Async because importing the signing key is. The returned deps also carry `jwks` — check 5 needs the
 * merchant's public key set, and `merchantKeySetFromJwks` is the one reader of it.
 */
export async function gateRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<GateDeps, CsError>> {
  const missing = missingGateEnv(env)
  if (missing.length > 0) {
    return {
      ok: false,
      error: csError(
        'CS_INTERNAL',
        `The Gate is not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} unset`,
        { missing: [...missing] },
        {
          userMessage:
            'Payment checking is not configured on this deployment, so no purchase can be approved.',
          retryable: false,
        },
      ),
    }
  }

  const vi = new ViClient({
    baseUrl: (env['VI_SERVICE_URL'] ?? '').trim(),
    token: (env['VI_SERVICE_TOKEN'] ?? '').trim(),
    clock: systemClock,
  })

  let signRecord: GateRepoHandles['signRecord']
  try {
    const key = await importSigningKey((env['GATE_SIGNING_KEY'] ?? '').trim())
    signRecord = recordSigner(key, env['GATE_KID'] ?? 'gate-1')
  } catch (cause) {
    // `csError` returns a plain `CsError` object, not an `Error`, so `cause instanceof Error` is false
    // for the validation failure this block exists to report — and `String({...})` renders as
    // `[object Object]`, which is how the first version of this message lost the reason it was written.
    const detail =
      cause instanceof Error
        ? cause.message
        : typeof cause === 'object' &&
            cause !== null &&
            typeof (cause as CsError).message === 'string'
          ? (cause as CsError).message
          : String(cause)
    return {
      ok: false,
      error: csError('CS_VALIDATION', `GATE_SIGNING_KEY could not be used: ${detail}`, undefined, {
        userMessage: 'Payment checking is misconfigured on this deployment.',
        retryable: false,
      }),
    }
  }

  // Check 5 compares the checkout JWT against the merchant key set. `merchantKeySetFromJwks` takes
  // **flattened** entries — the `public_jwk` document's own fields alongside the row's `role` and
  // `status` — because it filters on role and status before it looks at the key material. Flattening
  // here is one spread rather than a second reader of the table: the verifier page reads the same rows.
  const keyRows = await db().select().from(jwksKeys)
  const entries: Record<string, unknown>[] = keyRows.map((row) => {
    const jwk = (row.public_jwk ?? {}) as Record<string, unknown>
    return { ...jwk, kid: row.kid, role: row.role, status: row.status }
  })
  const merchantKeys: MerchantKeySet = merchantKeySetFromJwks(entries)

  const handles: GateRepoHandles = {
    clock: systemClock,
    requireMandate: repository.requireMandate,
    findAgentById: repository.findAgentById,
    findDeviceById: repository.findDeviceById,
    findL1ForDeviceWallet: repository.findL1ForDeviceWallet,
    requireCheckoutSession: repository.requireCheckoutSession,
    findProductsBySku: repository.findProductsBySku,
    countCommitsSince: repository.countCommitsSince,
    createAttempt: repository.createAttempt,
    findAttemptByL3Jti: repository.findAttemptByL3Jti,
    countRecentAttempts: repository.countRecentAttempts,
    listAttemptsForMandate: repository.listAttemptsForMandate,
    setMandateStatus: repository.setMandateStatus,
    budgetStore: repository.drizzleStore(),
    vi,
    merchantKeys,
    lockMandateForUpdate: repository.lockMandateForUpdate,
    walletCapPeriod: repository.findWalletCapPeriod,
    withTx: gateTransaction,
    signRecord,
  } as GateRepoHandles

  // `gateDepsFromRepos` is `packages/gate`'s own binder and the only thing that knows how these
  // seventeen members map onto the Gate's internal shape. Re-implementing that mapping here would be a
  // second source of truth for the Gate's wiring — the drift AGENTS.md rule 8 forbids. `defineGateDeps`
  // (inside it) rejects a partially-built object at construction rather than at the first check that
  // reads a missing member, which is the difference between a boot failure and a wrong `ALLOW`.
  return { ok: true, value: gateDepsFromRepos(handles) }
}
