/**
 * The probes behind `/status` — spec **§8.19**, §6, EC-ENV-1, EC-PP-1, EC-LLM-1.
 *
 * ## Why this is a separate module
 *
 * Because "the status page reports the real state" is a claim that has to be **testable**, and a claim
 * embedded in a Next route handler cannot be tested without booting a server. `probeAll` takes its
 * dependencies as arguments — `fetch`, the timeout, the store readers, and a `configured` flag per
 * dependency — so `status.test.ts` can point it at a dependency that is *configured and dead* and assert it
 * says `down`. That is the test that separates this from a page which reports "OpenAI: OK" because a key is
 * set.
 *
 * ## The rule every probe obeys
 *
 * **Call it, or admit you did not.** There are exactly three answers:
 *
 * | Answer | Means |
 * |---|---|
 * | `up` | the call was made and it answered |
 * | `down` | the call was made and it failed, timed out, or answered with the wrong shape |
 * | `not_configured` | the variable is absent, so **no call was made** — and that is stated rather than dressed up as a success |
 *
 * There is no fourth answer, and in particular no path from "a key exists" to `up`.
 *
 * ## Why each dependency is required, and what that costs
 *
 * See the route's header for the table. The part that matters here: **`not_configured` is never a failure**,
 * even for a required dependency. A required dependency that is not configured produces `ok: false` at the
 * report level (so Render sees a 503) while the probe row says `not_configured`, because "we have no
 * credentials" and "we tried and it refused" are different diagnoses and an operator needs to tell them
 * apart from a log line.
 */
import { systemClock } from '@countersign/core'
import { ViClient } from '@countersign/vi-client'

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                          */
/* ------------------------------------------------------------------------------------------ */

export type ProbeStatus = 'up' | 'down' | 'not_configured'

export interface DependencyProbe {
  /** Stable key, so a test and a log line can name the same thing. */
  readonly id: 'database' | 'vi' | 'paypal' | 'mcp' | 'openai'
  /** Human name for the page. */
  readonly name: string
  /**
   * Whether serving requests needs this. **This is the only input to the report's `ok`.**
   *
   * Postgres, vi-service and PayPal OAuth are required. OpenAI and MCP are not: §8.0 rule 4 makes the
   * deterministic paths the product, so a missing model key degrades the compiler and the notes drafter and
   * nothing else.
   */
  readonly required: boolean
  readonly status: ProbeStatus
  /** Measured round-trip. `null` when no call was made or none completed. */
  readonly latencyMs: number | null
  /** One sentence a human can act on. Never contains a credential. */
  readonly detail: string
}

export interface StatusReport {
  /** `true` only when every **required** probe is `up`. Maps 1:1 to the HTTP status. */
  readonly ok: boolean
  readonly checkedAt: {
    readonly epochSec: number
    readonly utc: string
    readonly ist: string
    readonly istHuman: string
  }
  readonly environment: {
    readonly appEnv: string | null
    readonly nodeEnv: string | null
    readonly paypalEnv: string | null
    readonly sandboxOnly: boolean
  }
  readonly dependencies: readonly DependencyProbe[]
  readonly webhook: {
    readonly lastReceivedAt: { readonly utc: string; readonly ist: string } | null
    readonly secondsSinceLast: number | null
    readonly backlogOldestSeconds: number
    readonly unprocessed: number | null
    readonly note: string
  }
  readonly viLibCommit: string
  /** Names only. Nothing on this side of the boundary is ever rendered. */
  readonly configured: Readonly<Record<string, boolean>>
}

/** Everything {@link probeAll} is allowed to reach. A closed list, like every other port in this repo. */
export interface ProbeDeps {
  readonly databaseConfigured: boolean
  readonly viConfigured: boolean
  readonly paypalConfigured: boolean
  readonly mcpConfigured: boolean
  readonly openaiConfigured: boolean
  readonly viBaseUrl: string
  readonly viToken: string
  readonly paypalClientId: string
  readonly paypalClientSecret: string
  readonly paypalBaseUrl: string
  readonly mcpUrl: string
  readonly openaiKey: string
  readonly fetchImpl: typeof fetch
  /**
   * Per-probe budget in milliseconds.
   *
   * **Not a connection timeout.** Each probe is raced against this budget with `Promise.race`, so a
   * dependency that accepts a socket and then hangs is reported `down` in bounded time. That is the whole
   * difference between a health check and a page that occasionally stops answering.
   */
  readonly timeoutMs: number
  /**
   * `SELECT 1`, injected.
   *
   * A port rather than a direct `db()` call for one reason: it is the only probe that needs a database, and
   * injecting it lets `status.test.ts` prove the *other four* probes' behaviour with no Postgres running. The
   * default is `sql-probe.ts`'s real implementation, loaded lazily.
   */
  readonly sqlProbe?: () => Promise<number>
}

/* ------------------------------------------------------------------------------------------ */
/* The probes                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Run every probe, concurrently, and report.
 *
 * Concurrent because a health check is on the critical path of a deploy, and sequential probes would make
 * its latency the **sum** of five dependencies rather than the slowest one. `Promise.all` also means one
 * hanging dependency cannot hide the others' results.
 *
 * @returns the probes, in a **fixed order** (database first), so two responses to the same state produce the
 *   same body and a diff of two health checks is meaningful.
 */
export async function probeAll(deps: ProbeDeps): Promise<DependencyProbe[]> {
  const [database, vi, paypal, mcp, openai] = await Promise.all([
    probeDatabase(deps),
    probeVi(deps),
    probePaypalOAuth(deps),
    probeMcp(deps),
    probeOpenAi(deps),
  ])
  return [database, vi, paypal, mcp, openai]
}

/** Time one call, and report `down` if it loses the race. Never throws. */
async function timed(
  deps: ProbeDeps,
  what: () => Promise<{ detail: string }>,
): Promise<
  { ok: true; detail: string; latencyMs: number } | { ok: false; detail: string; latencyMs: null }
> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `no answer within ${deps.timeoutMs} ms — the dependency may be configured and dead, or unreachable`,
            ),
          ),
        deps.timeoutMs,
      )
    })
    const answer = await Promise.race([what(), budget])
    return { ok: true, detail: answer.detail, latencyMs: Date.now() - started }
  } catch (cause) {
    return { ok: false, detail: messageOf(cause), latencyMs: null }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 1. Postgres                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * `SELECT 1`, through `packages/db`'s lazily-created pool.
 *
 * The cheapest statement that proves a connection, a password and a network path all work. Imported
 * lazily so this module — and therefore `status.test.ts` — never pulls `postgres` into a graph that does not
 * need it.
 */
async function probeDatabase(deps: ProbeDeps): Promise<DependencyProbe> {
  const base = {
    id: 'database' as const,
    name: 'Postgres',
    required: true,
  }
  if (!deps.databaseConfigured) {
    return {
      ...base,
      status: 'not_configured',
      latencyMs: null,
      detail: 'DATABASE_URL is not set.',
    }
  }
  const outcome = await timed(deps, async () => {
    const run = deps.sqlProbe ?? (await import('./sql-probe')).sqlProbe
    const row = await run()
    if (row !== 1) throw new Error(`SELECT 1 returned ${String(row)}`)
    return { detail: 'SELECT 1 answered 1.' }
  })
  return {
    ...base,
    status: outcome.ok ? 'up' : 'down',
    latencyMs: outcome.latencyMs,
    // `toRepoError` redacts, and a connection string is in `SECRET_ENV_KEYS`, so this message cannot carry a
    // password. It is filtered again by the no-secrets test.
    detail: outcome.ok ? outcome.detail : `Postgres is unreachable: ${outcome.detail}`,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 2. vi-service                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * `GET /v1/status` on vi-service — the crypto oracle, spec §8.3.
 *
 * **Required**, and the reason is the Gate: check 4 is `vi.verify(..., { strict: true })`, and a Gate that
 * cannot verify a chain must BLOCK. So an instance that cannot reach vi-service cannot gate a purchase, and
 * saying so with a 503 is more useful than accepting traffic it will refuse.
 *
 * The real `ViClient` is used with an injected `fetchImpl`, so this exercises the client's own URL handling,
 * bearer header, timeout and response validation rather than an ad-hoc `fetch`.
 */
async function probeVi(deps: ProbeDeps): Promise<DependencyProbe> {
  const base = { id: 'vi' as const, name: 'vi-service', required: true }
  if (!deps.viConfigured) {
    return {
      ...base,
      status: 'not_configured',
      latencyMs: null,
      detail: 'VI_SERVICE_URL or VI_SERVICE_TOKEN is not set, so no chain can be verified.',
    }
  }
  const outcome = await timed(deps, async () => {
    const client = new ViClient({
      baseUrl: deps.viBaseUrl,
      token: deps.viToken,
      fetchImpl: deps.fetchImpl,
      // A health check reports the wall clock, so `systemClock` is the honest source here rather than an
      // injected fixture — the latency numbers this probe returns are the ones a reader is looking at.
      clock: systemClock,
    })
    const status = await client.status()
    if (!status.ok) throw new Error(`${status.error.code}: ${status.error.message}`)
    if (status.value.ok !== true) throw new Error('vi-service reported ok: false')
    return {
      detail: `issuer kid ${status.value.issuer_kid}, merchant kid ${status.value.merchant_kid}, clock skew ${status.value.clock_skew_seconds}s.`,
    }
  })
  return {
    ...base,
    status: outcome.ok ? 'up' : 'down',
    latencyMs: outcome.latencyMs,
    detail: outcome.ok ? outcome.detail : `The Gate cannot verify a chain: ${outcome.detail}`,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 3. PayPal OAuth                                                                                */
/* ------------------------------------------------------------------------------------------ */

/**
 * `POST /v1/oauth2/token` with `grant_type=client_credentials` — §10.2 row 1, the first call in the table.
 *
 * **Required**, and this is the honest way to check it: "a client id and a secret are present" proves
 * nothing, because a revoked app, a rotated secret or a typo all leave both variables populated. Asking
 * PayPal for a token is the only check that can fail, and it costs nothing — the token is cached for
 * `expires_in − 60` and this is the same call the first real request would make.
 *
 * The **real** `PayPalClient` is used, so `assertSandbox` (EC-ENV-1) also runs here: a base URL that is not a
 * `*.sandbox.paypal.com` host fails the probe instead of quietly reporting OK.
 */
async function probePaypalOAuth(deps: ProbeDeps): Promise<DependencyProbe> {
  const base = { id: 'paypal' as const, name: 'PayPal OAuth', required: true }
  if (!deps.paypalConfigured) {
    return {
      ...base,
      status: 'not_configured',
      latencyMs: null,
      detail:
        'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_API_BASE is incomplete, so no PayPal call can be signed.',
    }
  }
  // **The module is loaded before the clock starts**, and that is not cosmetic. A cold Next instance pays
  // ~1s of module resolution the first time `@countersign/paypal` is imported, and a budget that included it
  // would report PayPal `down` on the very first `/status` request of a freshly deployed instance � a health
  // check that fails a healthy service because of its own start-up cost is worse than no health check. What
  // the budget must cover is the *network call*, so the import sits outside the race.
  const { PayPalClient } = await import('@countersign/paypal')
  const client = new PayPalClient({
    baseUrl: deps.paypalBaseUrl,
    clientId: deps.paypalClientId,
    clientSecret: deps.paypalClientSecret,
    fetchImpl: deps.fetchImpl,
    // The probe reports the wall clock, and `env` is pinned to sandbox so `assertSandbox` (EC-ENV-1) runs here
    // as it would in production � a base URL that is not a sandbox host fails this probe instead of quietly
    // reporting OK.
    clock: systemClock,
    env: { PAYPAL_ENV: 'sandbox', PAYPAL_API_BASE: deps.paypalBaseUrl },
  })
  const outcome = await timed(deps, async () => {
    const token = await client.getAccessToken()
    if (typeof token !== 'string' || token.trim() === '')
      throw new Error('no access token in the answer')
    return { detail: 'client_credentials exchange succeeded; the token is never printed.' }
  })
  return {
    ...base,
    status: outcome.ok ? 'up' : 'down',
    latencyMs: outcome.latencyMs,
    detail: outcome.ok ? outcome.detail : `No PayPal call can be signed: ${outcome.detail}`,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 4. MCP                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * The PayPal MCP endpoint (§8.14, D7) — a bare reachability check.
 *
 * **Not required.** It is only the agent's shopping tools (§8.13), and §11's check C3 may still be deciding
 * between the hosted server and a local `npx @paypal/mcp`. A down MCP degrades the agent chat and nothing
 * else, so it is reported and the report still says 200.
 *
 * The probe is deliberately **not** an MCP handshake: a full `initialize` needs a protocol version this
 * process has no opinion about, and §11 check C3 is still the authority on how to talk to it. A reachability
 * answer is what "is the endpoint there" means, and it is labelled as exactly that.
 */
async function probeMcp(deps: ProbeDeps): Promise<DependencyProbe> {
  const base = { id: 'mcp' as const, name: 'PayPal MCP', required: false }
  if (!deps.mcpConfigured) {
    return {
      ...base,
      status: 'not_configured',
      latencyMs: null,
      detail: 'PAYPAL_MCP_URL is not set; the agent has no shopping tools.',
    }
  }
  const outcome = await timed(deps, async () => {
    const response = await deps.fetchImpl(deps.mcpUrl, { method: 'GET' })
    // Any HTTP answer counts: 401 and 405 both prove the host is there and talking. Only a transport failure
    // is "down".
    if (response.status === 0) throw new Error('no HTTP status')
    return {
      detail: `reachable; answered ${response.status} to a bare GET (a handshake is not attempted).`,
    }
  })
  return {
    ...base,
    status: outcome.ok ? 'up' : 'down',
    latencyMs: outcome.latencyMs,
    detail: outcome.ok ? outcome.detail : `The agent has no shopping tools: ${outcome.detail}`,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* 5. OpenAI                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * `GET https://api.openai.com/v1/models` with the configured key.
 *
 * **Not required, and this is the row that proves "probe, do not assume" is not a slogan.** A key that is
 * set but revoked, or that belongs to a project with the quota spent, produces `down` here while every other
 * row says `up` — and the page says so. §8.0 rule 4 is the reason this dependency is optional: no LLM output
 * is ever authoritative, so the deterministic paths are the product and a missing key costs the compiler and
 * the drafter, not a purchase.
 */
async function probeOpenAi(deps: ProbeDeps): Promise<DependencyProbe> {
  const base = { id: 'openai' as const, name: 'OpenAI', required: false }
  if (!deps.openaiConfigured) {
    return {
      ...base,
      status: 'not_configured',
      latencyMs: null,
      detail:
        'OPENAI_API_KEY is not set. Intent compilation and dispute-note drafting are unavailable; the Gate, ' +
        'the orders and the Defender are not (spec §8.0 rule 4).',
    }
  }
  const outcome = await timed(deps, async () => {
    const response = await deps.fetchImpl('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { authorization: `Bearer ${deps.openaiKey}` },
    })
    if (response.status === 401 || response.status === 403) {
      throw new Error(`the key was refused (HTTP ${response.status})`)
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return { detail: 'the key was accepted; no model was called.' }
  })
  return {
    ...base,
    status: outcome.ok ? 'up' : 'down',
    latencyMs: outcome.latencyMs,
    detail: outcome.ok
      ? outcome.detail
      : `The key is configured but not usable: ${outcome.detail}. Nothing else is affected — no LLM output is authoritative.`,
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * One sentence from anything that was thrown.
 *
 * **`CsError` is not an `Error`.** `packages/db` and `packages/core` both throw `CsError` objects — a
 * deliberate design (spec §6 needs a `code` and a `userMessage` at boot), and the reason
 * `apps/worker/src/index.ts` has a branch for exactly this. String-interpolating one yields
 * `[object Object]`, which on a status page is worse than useless: it tells an operator nothing and looks
 * like the probe itself is broken. So the `code` and `message` are read explicitly.
 */
function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const shape = cause as { code?: unknown; message?: unknown }
    const message = typeof shape.message === 'string' ? shape.message : ''
    return typeof shape.code === 'string' && !message.startsWith(`${shape.code}:`)
      ? `${shape.code}: ${message}`
      : message
  }
  return String(cause)
}
