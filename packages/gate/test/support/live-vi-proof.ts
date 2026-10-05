/**
 * **The live end-to-end proof: `packages/gate`'s production binding against a real vi-service.**
 *
 * ## Why this is a script and not a test
 *
 * `test/chain-tokens.test.ts` is the regression test — it runs, in CI, in four seconds, and it would have
 * caught the defect. This is the other half: it proves the **wiring**, and it needs three things no unit
 * test can provide.
 *
 * 1. A real vi-service on a real socket. `apps/vi`'s FastAPI app under uvicorn, on 127.0.0.1:0.
 *    `fastapi.testclient` is deliberately not used here: `TestClient` never listens, so a real
 *    `ViClient` cannot reach it, and the whole point is that the client's bytes leave the process.
 * 2. A chain built by the service's own routes — `/v1/keys/agent`, `/v1/l1/issue`, `/v1/l2/prepare`,
 *    `/v1/l2/finalize`, `/v1/checkout-jwt`, `/v1/l3/create`, `POST /v1/verify` — so `l1` and `l2` are
 *    tokens `verifiable_intent` actually signed. `test/support/live-vi-chain.py` does that and then keeps
 *    serving.
 * 3. **`deps.ts::gateDepsFromRepos`.** Not `createInMemoryGateWorld`. This is the function a deployment
 *    calls, so this is where a port that was declared but never bound, or bound to the wrong repository,
 *    would show up. `deps.verify`, `deps.findL1ForDeviceWallet` and `deps.merchantKeys` are the real
 *    bindings over the real `ViClient`.
 *
 * ## What it proves, and what it deliberately does not
 *
 * It asserts the fetch count, check 4's verdict, and that `signedConstraints` came out of the live
 * `disclosed.l2` — the three facts that were false before the fix. It then drives the two fail-closed
 * paths against the same live service and asserts **zero** further fetches, because a Gate that cannot
 * show a chain must not ask about one.
 *
 * The only in-memory pieces are the Postgres repositories and the `BudgetStore`, because there is no
 * database in a proof run. Everything the defect touched is real.
 *
 * ## Running it
 *
 * ```
 * pnpm --filter @countersign/gate exec tsx test/support/live-vi-proof.ts
 * ```
 *
 * Requires `apps/vi/.venv` (already committed to the repo's dev setup) and exits non-zero on any failed
 * assertion. Not collected by `vitest`: it needs a Python interpreter and ~15 s, so it is not part of
 * `pnpm test`.
 */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compactVerify, generateKeyPair } from 'jose'
import { fixedClock, ok, type Result } from '@countersign/core'
import type {
  AgentId,
  AttemptId,
  CheckoutId,
  CsError,
  MandateId,
  WalletId,
} from '@countersign/core'
import type {
  AgentRow,
  BudgetAccountRow,
  CheckoutAttemptRow,
  CheckoutSessionRow,
  DeviceRow,
  Exec,
  L1Row,
  MandateRow,
  ProductRow,
} from '@countersign/db'
import { ViClient } from '@countersign/vi-client'

import { createInMemoryBudgetStore, gateDepsFromRepos } from '../../src/deps'
import {
  check1MandateActive,
  check4ChainVerify,
  type CheckContext,
  type CheckState,
} from '../../src/checks'
import { recordSigner } from '../../src/decision-record'
import { evaluate } from '../../src/evaluate'
import { NO_DISCLOSED_CONSTRAINTS } from '../../src/signed-constraints'
import type { GateDecision, GateDeps, GateInput } from '../../src/types'

/* ------------------------------------------------------------------------------------------ */
/* The live vi-service                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** Exactly what `test/support/live-vi-chain.py` emits. */
interface LiveChain {
  readonly base_url: string
  readonly service_token: string
  readonly agent_id: string
  readonly agent_kid: string
  readonly merchant_id: string
  readonly sku: string
  readonly item_title: string
  readonly unit_minor: number
  readonly shipping_minor: number
  readonly tax_minor: number
  readonly total_minor: number
  readonly currency: string
  readonly signed_budget_max: number
  readonly l1: string
  readonly l2: string
  readonly l2_payload: Record<string, unknown>
  readonly l3a: string
  readonly l3b: string
  readonly jti: string
  readonly checkout_jwt: string
  readonly checkout_hash: string
  readonly verify_response: Record<string, unknown>
  readonly captured_at_utc: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..', '..')
const PYTHON = join(REPO, 'apps', 'vi', '.venv', 'Scripts', 'python.exe')
const DRIVER = join(HERE, 'live-vi-chain.py')

/** Spawn the Python driver and read back its one line of JSON. It stays alive serving uvicorn. */
async function startLiveViService(): Promise<{
  readonly chain: LiveChain
  readonly stop: () => void
}> {
  const child = spawn(PYTHON, [DRIVER], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const chain = await new Promise<LiveChain>((resolveChain, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`the vi driver did not answer in 120s.\nstdout:\n${out}\nstderr:\n${stderr}`),
        ),
      120_000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const at = out.indexOf('@@CHAIN@@')
      if (at < 0) return
      clearTimeout(timer)
      resolveChain(JSON.parse(out.slice(at + '@@CHAIN@@'.length).trim()) as LiveChain)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the vi driver exited with ${code}.\nstdout:\n${out}\nstderr:\n${stderr}`))
    })
  })

  return { chain, stop: () => child.kill() }
}

/* ------------------------------------------------------------------------------------------ */
/* Ids and numbers                                                                              */
/* ------------------------------------------------------------------------------------------ */

const MANDATE_ID = 'mdt_liveproof0000000000000001' as MandateId
const DEVICE_ID = 'dev_liveproof0000000000000001' as `dev_${string}`
const WALLET_ID = 'wal_liveproof0000000000000001' as WalletId
const ATTEMPT_ID = 'att_liveproof0000000000000001' as AttemptId
const CHECKOUT_ID = 'chk_live_proof_1' as CheckoutId
const GATE_KID = 'gate-live-proof'

/** The `$130.00` ceiling the live service signs into the L2. In minor units. */
const SIGNED_BUDGET_MINOR = 13_000n
/**
 * A `budget_accounts.cap_minor` **twenty times looser** than the signature, in the spirit of QA-gate-1:
 * the cached cap can never be what stops or allows the purchase, so anything the detail says about the
 * binding cap is attributable to the token.
 */
const ACCOUNT_CAP_MINOR = 260_000n

/**
 * `evaluate` returns a `Result`, and a proof that quietly treated a failure as a decision would report
 * success for the wrong reason — the exact class of mistake this harness exists to rule out. So every
 * call is unwrapped loudly.
 */
function unwrap(what: string, result: Result<GateDecision, CsError>): GateDecision {
  if (!result.ok) {
    throw new Error(`${what} failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}

/* ------------------------------------------------------------------------------------------ */
/* main                                                                                         */
/* ------------------------------------------------------------------------------------------ */

async function main(): Promise<number> {
  const { chain, stop } = await startLiveViService()
  const failures: string[] = []
  const line = '-'.repeat(100)
  const rule = '='.repeat(100)

  try {
    console.log(rule)
    console.log('LIVE END-TO-END PROOF — packages/gate through deps.ts::gateDepsFromRepos')
    console.log(rule)
    console.log(
      `vi-service          : ${chain.base_url}  (uvicorn, apps/vi/src/vi_service/main.py)`,
    )
    console.log(`chain captured at   : ${chain.captured_at_utc}`)
    console.log(`/v1/verify verdict  : chain_valid=${String(chain.verify_response['chain_valid'])}`)
    console.log(
      `constraints.skipped : ${JSON.stringify(
        (chain.verify_response['constraints'] as Record<string, unknown> | undefined)?.['skipped'],
      )}`,
    )
    console.log(`signed budget in L2 : ${chain.signed_budget_max} ${chain.currency}`)
    console.log('')

    const nowSec = Math.floor(Date.now() / 1000)

    // --- the rows a deployment would have read out of Postgres, built from the tokens just issued ----

    const mandateRow = {
      id: MANDATE_ID,
      user_id: 'usr_live_proof_user',
      device_id: DEVICE_ID,
      agent_id: chain.agent_id,
      wallet_id: WALLET_ID,
      // **The fix, in one line.** `check1MandateActive` reads this column and check 4 sends it as `l2`.
      l2_serialized: chain.l2,
      l2_payload: chain.l2_payload,
      nl_intent: 'Buy running shoes up to $130.00 at Northwind',
      readback: 'Spend at most $130.00 at Northwind Outfitters',
      // The QA-gate-2 cache is empty on purpose: the signature must be the only source.
      constraints: [],
      nonce: 'nonce-live-1',
      aud: 'https://agent.countersign.test',
      iat: BigInt(nowSec - 60),
      exp: BigInt(nowSec + 86_400),
      status: 'ACTIVE',
      revoked_at: null,
      revoked_reason: null,
      webauthn_assertion: null,
      compiler_model: 'n/a (live proof)',
      compiler_trace_id: null,
      created_at: new Date((nowSec - 60) * 1000),
      updated_at: new Date((nowSec - 60) * 1000),
    } as unknown as MandateRow

    const agentRow = {
      id: chain.agent_id,
      kid: chain.agent_kid, // the real kid from POST /v1/keys/agent
      status: 'ACTIVE',
    } as unknown as AgentRow

    const deviceRow = { id: DEVICE_ID, status: 'ACTIVE' } as unknown as DeviceRow

    // The **real** L1 the service just issued. This is what `repos/devices.ts::findL1ForDeviceWallet`
    // would return for this device × wallet.
    const l1Row = {
      id: 'l1_liveproof00000000000000001',
      user_id: 'usr_live_proof_user',
      device_id: DEVICE_ID,
      wallet_id: WALLET_ID,
      sd_jwt: chain.l1,
      issuer_kid: 'issuer-key-1',
      iat: BigInt(nowSec - 60),
      exp: BigInt(nowSec + 86_400),
      status: 'ACTIVE',
      created_at: new Date((nowSec - 60) * 1000),
      updated_at: new Date((nowSec - 60) * 1000),
    } as unknown as L1Row

    const sessionRow = {
      id: CHECKOUT_ID,
      merchant_id: chain.merchant_id,
      // `cart` is JSONB, so `unit_minor` is stored as a decimal string — exactly as `drizzle-kit`
      // would have to write it. See `test/fixtures.ts::makeWorld`.
      cart: { lines: [{ sku: chain.sku, qty: 1, unit_minor: String(chain.unit_minor) }] },
      subtotal_minor: BigInt(chain.unit_minor),
      tax_minor: BigInt(chain.tax_minor),
      shipping_minor: BigInt(chain.shipping_minor),
      total_minor: BigInt(chain.total_minor),
      currency: chain.currency,
      checkout_jwt: chain.checkout_jwt, // the real price lock from POST /v1/checkout-jwt
      checkout_hash: chain.checkout_hash,
      price_lock_exp: new Date((nowSec + 900) * 1000),
      status: 'CREATED',
      created_at: new Date(nowSec * 1000),
      updated_at: new Date(nowSec * 1000),
    } as unknown as CheckoutSessionRow

    const productRow = {
      sku: chain.sku,
      title: chain.item_title,
      description: 'A trail running shoe.',
      price_minor: BigInt(chain.unit_minor),
      currency: chain.currency,
      stock: 25,
      ships_in_days: 3,
      digital: false,
      listing_html: '<p>Trail Runner</p>',
      created_at: new Date(nowSec * 1000),
      updated_at: new Date(nowSec * 1000),
    } as unknown as ProductRow

    const budgetAccount = {
      mandate_id: MANDATE_ID,
      currency: chain.currency,
      cap_minor: ACCOUNT_CAP_MINOR,
      reserved_minor: 0n,
      spent_minor: 0n,
      version: 0,
      created_at: new Date(nowSec * 1000),
      updated_at: new Date(nowSec * 1000),
    } as unknown as BudgetAccountRow

    // --- the REAL ViClient, counting its own fetches ---------------------------------------------

    let fetchCount = 0
    const calls: string[] = []
    const countingFetch: typeof fetch = (input, init) => {
      fetchCount += 1
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return fetch(input, init)
    }

    const vi = new ViClient({
      baseUrl: chain.base_url,
      token: chain.service_token,
      clock: fixedClock(nowSec),
      fetchImpl: countingFetch,
      maxRetries: 0,
      timeoutMs: 15_000,
    })

    // --- a real Gate signing key, so the decision record is a real signature ----------------------

    const gatePair = await generateKeyPair('Ed25519', { extractable: true })
    const signRecord = recordSigner(gatePair.privateKey, GATE_KID)

    // --- the production wiring --------------------------------------------------------------------

    const gateDeps: GateDeps = gateDepsFromRepos({
      clock: fixedClock(nowSec),
      budgetStore: createInMemoryBudgetStore({ accounts: [budgetAccount] }),
      requireMandate: async () => ok(mandateRow),
      findAgentById: async () => ok(agentRow),
      findDeviceById: async () => ok(deviceRow),
      // **The new port**, bound to the real `repos/devices.ts` function's shape. Returns the L1
      // `apps/vi` just issued, and `undefined` for any other device × wallet — §7.2's unique index
      // means there is no second row to fall back to.
      findL1ForDeviceWallet: async (
        deviceId,
        walletId,
      ): Promise<Result<L1Row | undefined, CsError>> =>
        ok(deviceId === DEVICE_ID && walletId === WALLET_ID ? l1Row : undefined),
      requireCheckoutSession: async () => ok(sessionRow),
      findProductsBySku: async () => ok([productRow]),
      countCommitsSince: async () => ok(0),
      createAttempt: async (attempt) =>
        ok({
          id: attempt.id,
          mandate_id: attempt.mandate_id,
          agent_id: attempt.agent_id,
          checkout_session_id: attempt.checkout_session_id,
          l3a: attempt.l3a,
          l3b: attempt.l3b,
          l3_jti: attempt.l3_jti,
          idempotency_key: attempt.idempotency_key,
          amount_minor: attempt.amount_minor,
          currency: attempt.currency,
          payee: attempt.payee,
          state: 'CREATED',
          gate_decision_id: null,
          created_at: new Date(nowSec * 1000),
          updated_at: new Date(nowSec * 1000),
        } as unknown as CheckoutAttemptRow),
      findAttemptByL3Jti: async () => ok(undefined),
      countRecentAttempts: async () => ok(0),
      listAttemptsForMandate: async () => ok([]),
      setMandateStatus: async () => ok(mandateRow),
      // There is no Postgres here, so there is no transaction handle to pass. The callback still runs
      // and the rollback signal is still honoured — `check8Budget` only reads through it.
      withTx: async (fn) => {
        let rolledBack = false
        let reason = ''
        const value = await fn(null as unknown as Exec, {
          rollback(why: string) {
            rolledBack = true
            reason = why
          },
          get rolledBack() {
            return rolledBack
          },
        })
        if (rolledBack) void reason
        return value
      },
      lockMandateForUpdate: async () => ok(mandateRow),
      walletCapPeriod: async () => ok(undefined),
      vi, // **the real ViClient.** Check 4 (`verify`) and check 5 (`jwks`) both go through it.
      signRecord,
    })

    const gateInput: GateInput = {
      attemptId: ATTEMPT_ID,
      mandateId: MANDATE_ID,
      checkoutId: CHECKOUT_ID,
      l3a: chain.l3a, // the real L3a from POST /v1/l3/create
      l3b: chain.l3b, // the real L3b
      agentId: chain.agent_id as AgentId,
    }

    // --- PASS 1 — the whole decision, through the production binding -----------------------------

    console.log(line)
    console.log('PASS 1 — evaluate(GateInput, gateDepsFromRepos({ vi: <real ViClient> }))')
    console.log(line)

    const before = fetchCount
    const outcome = unwrap('evaluate (PASS 1)', await evaluate(gateInput, gateDeps))
    const fetchesForDecision = fetchCount - before

    console.log(`decision                  : ${outcome.decision}`)
    console.log(`fetches issued by the Gate: ${fetchesForDecision}`)
    for (const call of calls) console.log(`    ${call}`)
    console.log('')
    for (const check of outcome.checks) {
      const flag = check.notApplicable === true ? 'n/a ' : check.passed ? 'PASS' : 'FAIL'
      console.log(
        `check ${String(check.n).padStart(2)}  ${flag}  ${check.code.padEnd(16)}  ${check.detail ?? ''}`,
      )
    }
    console.log('')
    console.log(`pendingNetworkEnforcement : ${JSON.stringify(outcome.pendingNetworkEnforcement)}`)
    console.log(
      `reservation               : ${JSON.stringify(outcome.reservation ?? null, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      )}`,
    )
    console.log(`reason codes              : ${JSON.stringify(outcome.reasons.map((r) => r.code))}`)
    console.log('')

    // --- the fetch count is the whole point ---------------------------------------------------

    if (fetchesForDecision < 2) {
      failures.push(
        `the Gate issued only ${fetchesForDecision} fetch(es). Check 4 (POST /v1/verify) and check 5 ` +
          `(GET /v1/jwks) must both reach the live service. A count of 0 on /v1/verify is the exact ` +
          `symptom of the defect: an empty l1/l2 is refused client-side, before any network traffic.`,
      )
    }

    const check4 = outcome.checks.find((c) => c.n === 4)
    if (!check4?.passed) failures.push(`check 4 did not pass: ${check4?.detail}`)
    if (!check4?.detail?.includes('l1_credentials.sd_jwt')) {
      failures.push(`check 4's detail does not name the L1 it read: ${check4?.detail}`)
    }
    if (!check4?.detail?.includes('mandates.l2_serialized')) {
      failures.push(`check 4's detail does not name the L2 it read: ${check4?.detail}`)
    }

    // --- signedConstraints, out of the LIVE response ----------------------------------------------

    console.log(line)
    console.log('state.signedConstraints — read from the LIVE /v1/verify disclosed.l2')
    console.log(line)

    const state: CheckState = {
      mandate: null,
      agent: null,
      device: null,
      checkout: null,
      l3a: null,
      l3b: null,
      l3aHeaderKid: null,
      checkoutJwt: null,
      merchantKeys: null,
      reserveAmount: null,
      reservation: null,
      reservationError: null,
      velocity: null,
      chainValid: false,
      pending: [],
      signedConstraints: NO_DISCLOSED_CONSTRAINTS,
    }
    const ctx: CheckContext = {
      input: gateInput,
      deps: gateDeps,
      nowSec,
      now: new Date(nowSec * 1000),
      skewSec: 300,
      state,
      hooks: {},
    }

    // The same production check functions, so `signedConstraints` can be printed rather than inferred.
    const first = await check1MandateActive(ctx)
    const fourth = await check4ChainVerify(ctx)
    console.log(
      `check 1 (for the state) : ${first.check.passed ? 'PASS' : 'FAIL'} ${first.check.detail ?? ''}`,
    )
    console.log(
      `check 4 (for the state) : ${fourth.check.passed ? 'PASS' : 'FAIL'} ${fourth.check.detail ?? ''}`,
    )
    console.log('')
    console.log(`state.chainValid                    : ${state.chainValid}`)
    console.log(`state.pending (the D19 obligation)   : ${JSON.stringify(state.pending)}`)
    console.log(`state.signedConstraints.source      : ${state.signedConstraints.source}`)
    console.log(
      `state.signedConstraints.vcts        : ${JSON.stringify(state.signedConstraints.vcts)}`,
    )
    console.log(
      `state.signedConstraints.constraints : ${state.signedConstraints.constraints.length} entries`,
    )
    // `constraints` is `readonly unknown[]` — the reader's contract is "unvalidated". Narrowing to an
    // object first is what makes indexing legal, and the second clause is the filter proper.
    const budgets = state.signedConstraints.constraints.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>)['type'] === 'mandate.payment.budget',
    )
    console.log(`  the signed budget constraint : ${JSON.stringify(budgets)}`)
    console.log('')

    if (state.signedConstraints.constraints.length === 0) {
      failures.push(
        'signedConstraints is empty, so the D19 obligation guard is inert and check 8 falls back to ' +
          'budget_accounts.cap_minor — the QA-gate-1 overspend, still reachable',
      )
    }
    if (budgets.length !== 1 || budgets[0]?.['max'] !== chain.signed_budget_max) {
      failures.push(`signedConstraints did not carry the live budget: ${JSON.stringify(budgets)}`)
    }
    if (!state.pending.includes('mandate.payment.budget')) {
      failures.push(`pending omits mandate.payment.budget: ${JSON.stringify(state.pending)}`)
    }
    if (outcome.pendingNetworkEnforcement.length === 0) {
      failures.push('the decision record carries no pendingNetworkEnforcement')
    }

    // --- check 8 read the SIGNATURE, not our column ----------------------------------------------

    const check8 = outcome.checks.find((c) => c.n === 8)
    if (check8 && !check8.detail?.includes('the signed L2')) {
      failures.push(`check 8 did not name the signed L2 among the candidate caps: ${check8.detail}`)
    }
    if (check8 && !check8.detail?.includes(SIGNED_BUDGET_MINOR.toString())) {
      failures.push(`check 8's detail does not carry the signed ceiling: ${check8.detail}`)
    }

    // --- PASS 2 — fail closed, against the same live service -------------------------------------

    console.log(line)
    console.log('PASS 2 — the same live service, with the L1 genuinely absent')
    console.log(line)

    const noL1Deps: GateDeps = {
      ...gateDeps,
      findL1ForDeviceWallet: async () => ok(undefined),
    }
    const beforeNoL1 = fetchCount
    const noL1 = unwrap(
      'evaluate (PASS 2)',
      await evaluate(
        { ...gateInput, attemptId: 'att_liveproof0000000000000002' as AttemptId },
        noL1Deps,
      ),
    )
    const noL1Fetches = fetchCount - beforeNoL1
    const noL1Check4 = noL1.checks.find((c) => c.n === 4)!
    console.log(`decision : ${noL1.decision}`)
    console.log(`check  4 : ${noL1Check4.passed ? 'PASS' : 'FAIL'} ${noL1Check4.detail}`)
    console.log(`fetches  : ${noL1Fetches}  (must be 0 — /v1/verify was never called)`)
    console.log('')
    if (noL1.decision !== 'BLOCK') failures.push('a mandate with no L1 did not BLOCK')
    if (!noL1Check4.detail?.includes('l1_credentials')) {
      failures.push(`check 4 did not name l1_credentials: ${noL1Check4.detail}`)
    }
    if (noL1Fetches !== 0) failures.push('a chain with no L1 was still sent to /v1/verify')

    console.log(line)
    console.log('PASS 3 — the same live service, with mandates.l2_serialized empty')
    console.log(line)

    const noL2Deps: GateDeps = {
      ...gateDeps,
      mandate: async () => ok({ ...mandateRow, l2_serialized: '' } as MandateRow),
    }
    const beforeNoL2 = fetchCount
    const noL2 = unwrap(
      'evaluate (PASS 3)',
      await evaluate(
        { ...gateInput, attemptId: 'att_liveproof0000000000000003' as AttemptId },
        noL2Deps,
      ),
    )
    const noL2Fetches = fetchCount - beforeNoL2
    const noL2Check4 = noL2.checks.find((c) => c.n === 4)!
    console.log(`decision : ${noL2.decision}`)
    console.log(`check  4 : ${noL2Check4.passed ? 'PASS' : 'FAIL'} ${noL2Check4.detail}`)
    console.log(`fetches  : ${noL2Fetches}  (must be 0 — /v1/verify was never called)`)
    console.log('')
    if (noL2.decision !== 'BLOCK') failures.push('a mandate with no L2 did not BLOCK')
    if (!noL2Check4.detail?.includes('l2_serialized')) {
      failures.push(`check 4 did not name l2_serialized: ${noL2Check4.detail}`)
    }
    if (noL2Fetches !== 0) failures.push('a chain with no L2 was still sent to /v1/verify')

    // --- the decision record, verified ----------------------------------------------------------

    console.log(line)
    console.log('The signed decision record, verified against the freshly generated GATE key')
    console.log(line)
    let recordVerified = true
    try {
      await compactVerify(outcome.signedRecord, gatePair.publicKey)
    } catch {
      recordVerified = false
    }
    console.log(`JWS verified : ${recordVerified}`)
    console.log('')
    if (!recordVerified) failures.push('the decision record signature did not verify')

    // --- verdict ---------------------------------------------------------------------------------

    console.log(rule)
    if (failures.length === 0) {
      console.log('PROOF: PASS — the production deps.ts binding verified a live chain end to end.')
      console.log(`       ${fetchesForDecision} fetches against ${chain.base_url}.`)
      console.log(
        `       Check 4 passed; signedConstraints carried ${state.signedConstraints.constraints.length} real constraints.`,
      )
      console.log(`       A missing L1 or L2 BLOCKed with 0 fetches.`)
      console.log(rule)
      return 0
    }
    console.log('PROOF: FAIL')
    for (const failure of failures) console.log(`  - ${failure}`)
    console.log(rule)
    return 1
  } finally {
    stop()
  }
}

main().then(
  (code) => {
    process.exit(code)
  },
  (cause: unknown) => {
    console.error(cause)
    process.exit(1)
  },
)
