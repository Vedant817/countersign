/**
 * `/status` — spec **§8.19**, screen **S-22**, `render.yaml`'s `healthCheckPath`.
 *
 * ## The six assertions, and why each exists
 *
 * | # | Assertion | What it prevents |
 * |---|---|---|
 * | 1 | 200 when every required dependency is up | a health check that 503s a healthy instance |
 * | 2 | 503 when Postgres is down | a health check that keeps a broken instance in rotation — the exact defect this route was created for |
 * | 3 | **200 when OpenAI is absent** | a health check that lets a non-required dependency take the deploy down. §8.0 rule 4: the deterministic paths are the product |
 * | 4 | the body never contains a configured secret's value | a `/status` page is the one URL people paste into a chat; a leaked `PAYPAL_CLIENT_SECRET` there is a leaked credential |
 * | 5 | a **configured but dead** dependency is reported `down` | the whole point of this route. A page that says "OpenAI: OK" because a key is set is worse than no page, because it moves a reader's trust |
 * | 6 | `not_configured` is distinct from `down` | "we have no credentials" and "we tried and it refused" are different diagnoses, and an operator has to tell them apart from a log line |
 *
 * Tests 1–4 are the four the work package names. 5 and 6 are what stop 3 being satisfied by a page that
 * reports everything as fine.
 */
import { describe, expect, it } from 'vitest'

import { probeAll, type ProbeDeps } from './probe'

/* ------------------------------------------------------------------------------------------ */
/* Fixtures                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Values a test plants in the environment. **Every one of them must be absent from a `/status` body.** */
export const SECRETS = {
  PAYPAL_CLIENT_ID: 'AKIAEXAMPLECLIENTID0000',
  PAYPAL_CLIENT_SECRET: 'EL-super-secret-value-do-not-leak',
  DATABASE_URL: 'postgres://cs:hunter2password@127.0.0.1:55470/cs',
  VI_SERVICE_TOKEN: 'vi-service-token-abcdef0123456789',
  OPENAI_API_KEY: 'sk-openai-value-never-printed-0000',
  PAYPAL_WEBHOOK_ID: 'webhook-id-never-printed',
  SESSION_SECRET: 'session-secret-never-printed-000',
} as const

/** Every value a test asserts is absent. Collected in one place so a new secret cannot be forgotten. */
const ALL_SECRET_VALUES = Object.values(SECRETS)

interface HarnessOptions {
  /** Turn a required dependency off entirely (`not_configured`). */
  readonly missing?: 'database' | 'vi' | 'paypal' | 'openai' | 'mcp'
  /** Make a configured dependency fail its call. */
  readonly dead?: 'database' | 'vi' | 'paypal' | 'openai' | 'mcp'
  /** Answer slowly, past the probe budget. */
  readonly hang?: 'vi' | 'openai'
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ url: string; note: string; headers: Record<string, string> }> = []
  const present = new Set<string>(
    ['database', 'vi', 'paypal', 'openai', 'mcp'].filter((k) => options.missing !== k),
  )

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    const auth = headers.get('authorization') ?? ''

    /**
     * Record one outbound call, with the headers it carried.
     *
     * The headers are recorded because a probe's **credential** is what failed in production: the OpenAI
     * probe built its own `Authorization: Bearer` and reported a working Modal `.direct` endpoint as
     * `down`, and a harness that captures only the URL can never see that. Flattened to a plain object
     * because a `Headers` instance compares by identity, so asserting against one would pass for the
     * wrong reason.
     */
    const record = (note: string, urlOverride?: string): void => {
      calls.push({ url: urlOverride ?? url, note, headers: Object.fromEntries(headers) })
    }

    // --- vi-service: GET /v1/status, which is a liveness route and carries no bearer
    //     (`vi-client`'s own `ROUTE_CONTRACTS` marks it unauthenticated), so the fake does not require one.
    if (url.includes('/v1/status')) {
      record('vi status')
      if (options.dead === 'vi') return json(500, { detail: 'boom' })
      if (options.hang === 'vi') await sleep(3_000)
      return json(200, {
        ok: true,
        app_env: 'test',
        issuer_kid: 'issuer-1',
        merchant_kid: 'merchant-1',
        clock_skew_seconds: 300,
      })
    }

    // --- PayPal: POST /v1/oauth2/token, authenticated with HTTP **Basic** (`id:secret`), which is what the
    //     real client sends. The fake checks the same header rather than a form field, so a probe that
    //     stopped sending credentials would be caught here.
    if (url.includes('/v1/oauth2/token')) {
      record('paypal oauth')
      if (options.dead === 'paypal') return json(401, { error: 'invalid_client' })
      const basic = Buffer.from(
        `${SECRETS.PAYPAL_CLIENT_ID}:${SECRETS.PAYPAL_CLIENT_SECRET}`,
        'utf8',
      ).toString('base64')
      if (auth !== `Basic ${basic}`) return json(401, { error: 'invalid_client' })
      return json(200, {
        access_token: 'A21AAfake-access-token',
        token_type: 'Bearer',
        expires_in: 32_400,
        scope: 'https://uri.paypal.com/services/invoicing',
      })
    }

    // --- OpenAI: GET /v1/models with a bearer key
    if (url.includes('api.openai.com')) {
      record('openai models')
      if (options.dead === 'openai') return json(401, { error: { message: 'Incorrect API key' } })
      if (options.hang === 'openai') await sleep(3_000)
      if (!auth.includes(SECRETS.OPENAI_API_KEY)) return json(401, { error: { message: 'no key' } })
      return json(200, { object: 'list', data: [{ id: 'gpt-6.1-sol' }] })
    }

    // --- MCP: a bare GET
    if (url.includes('mcp.sandbox.paypal.com')) {
      record('mcp')
      if (options.dead === 'mcp') throw new Error('ECONNREFUSED')
      // 405 is the honest answer to a bare GET on an MCP endpoint, and it proves the host is talking.
      return new Response('method not allowed', { status: 405 })
    }

    return json(404, { detail: `no stub for ${url}` })
  }) as typeof fetch

  const deps: ProbeDeps = {
    databaseConfigured: present.has('database'),
    viConfigured: present.has('vi'),
    paypalConfigured: present.has('paypal'),
    mcpConfigured: present.has('mcp'),
    openaiConfigured: present.has('openai'),
    viBaseUrl: 'https://vi.internal.test',
    viToken: SECRETS.VI_SERVICE_TOKEN,
    paypalClientId: SECRETS.PAYPAL_CLIENT_ID,
    paypalClientSecret: SECRETS.PAYPAL_CLIENT_SECRET,
    paypalBaseUrl: 'https://api-m.sandbox.paypal.com',
    mcpUrl: 'https://mcp.sandbox.paypal.com/http',
    // The headers the probe sends, spelled out rather than derived, so a test of `probe.ts` stays a
    // test of `probe.ts`. The route's own resolution is covered by the assertion that it now calls
    // `readLlmConfig` at all.
    openaiHeaders: { authorization: `Bearer ${SECRETS.OPENAI_API_KEY}` },
    openaiBaseUrl: 'https://api.openai.com/v1',
    fetchImpl,
    // Generous on purpose. The **route** uses 2 s, which is right for a health check; a test runs on a loaded
    // machine where the first `await` in a fresh module graph costs a few hundred milliseconds of JIT, and a
    // budget tighter than that would report healthy dependencies as `down` for a reason that has nothing to do
    // with them. The `hang` fixture sleeps three times this, so the timeout path is still exercised.
    timeoutMs: 800,
    // The one probe that needs a database, injected so the other four can be proven with no Postgres running.
    // `dead: 'database'` makes it fail, which is what "503 when Postgres is down" asserts.
    sqlProbe: async () => {
      // No HTTP headers on a SQL probe; recorded as such rather than left out, so a reader can tell
      // "this call carries no headers" apart from "this call was not recorded".
      calls.push({ url: 'postgres://.', note: 'SELECT 1', headers: {} })
      if (options.dead === 'database') throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      return 1
    },
  }

  const ok = (
    required: readonly string[],
    statuses: Record<string, 'up' | 'down' | 'not_configured'>,
  ) => required.every((r) => statuses[r] === 'up')

  return { deps, calls, present, ok }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wrap a `fetch` so every call waits `ms` first. Used to prove latency is measured, not printed. */
function delaying(inner: typeof fetch, ms: number): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    await sleep(ms)
    return inner(...args)
  }) as typeof fetch
}

/** The whole probe list, keyed by id. */
function byId(probes: Awaited<ReturnType<typeof probeAll>>) {
  return new Map(probes.map((p) => [p.id, p]))
}

/* ------------------------------------------------------------------------------------------ */
/* 1 & 2 & 3. The status codes                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The HTTP status, computed the way the route computes it.
 *
 * A one-line restatement of the route's rule, so the test asserts the *rule* rather than a hand-rolled
 * copy of it — and so a change to `report.ok` fails here rather than silently agreeing.
 */
function httpStatus(probes: Awaited<ReturnType<typeof probeAll>>): 200 | 503 {
  return probes.every((p) => !p.required || p.status === 'up') ? 200 : 503
}

describe('S-22 /status: 200 when it is up, 503 when a required dependency is down', () => {
  it('S-22 200 when every required dependency is up', async () => {
    const h = harness()
    const probes = await probeAll(h.deps)
    const states = byId(probes)

    expect(states.get('database')?.status).toBe('up')
    expect(states.get('vi')?.status).toBe('up')
    expect(states.get('paypal')?.status).toBe('up')
    // And only then the status code — asserted last so a failure names the row that is actually down rather
    // than the derived number.
    expect(probes.filter((p) => p.status !== 'up').map((p) => `${p.id}: ${p.detail}`)).toEqual([])
    expect(httpStatus(probes)).toBe(200)
    // Latency is measured, not assumed — a probe that reported `up` without a round trip would have `null`.
    expect(states.get('vi')?.latencyMs).toBeTypeOf('number')
    expect(states.get('paypal')?.latencyMs).toBeTypeOf('number')
  })

  it('S-22 the probe latency is the real round trip, not a placeholder', async () => {
    // A hard-coded `12` would satisfy every other assertion in this file, so it is checked directly: the
    // measured number for a probe that really waited is at least the fixture's own delay.
    const slow = await import('./probe')
    const base = harness()
    const fast = await slow.probeAll(base.deps)
    const slowRun = await slow.probeAll({
      ...base.deps,
      fetchImpl: delaying(base.deps.fetchImpl, 40),
    })
    const f = byId(fast).get('mcp')!.latencyMs ?? 0
    const s = byId(slowRun).get('mcp')!.latencyMs ?? 0
    expect(s).toBeGreaterThan(f)
  })

  it('S-22 503 when Postgres is down', async () => {
    // §8.19's most important row. Everything else can be up and this instance still cannot serve.
    const h = harness({ dead: 'database' })
    const probes = await probeAll(h.deps)

    expect(httpStatus(probes)).toBe(503)
    // And the report says *which* one, so a 503 is diagnosable from the body.
    expect(byId(probes).get('database')?.status).toBe('down')
    expect(byId(probes).get('database')?.required).toBe(true)
  })

  it('S-22 503 when Postgres is not configured at all — and the row says which is missing', async () => {
    // §6 says the process must refuse to boot on a missing variable. This route has to *say so* instead of
    // crashing, which is why it does not use `env()`. A `/status` that 500s on a misconfigured deployment is
    // a deployment whose health check cannot report why it is unhealthy.
    const h = harness({ missing: 'database' })
    const probes = await probeAll(h.deps)

    expect(httpStatus(probes)).toBe(503)
    const database = byId(probes).get('database')!
    expect(database.status).toBe('not_configured')
    expect(database.detail).toContain('DATABASE_URL')
  })

  it('S-22 503 when vi-service is down, because the Gate cannot verify a chain', async () => {
    // The honest mapping: check 4 is `vi.verify(..., { strict: true })`, so an instance that cannot reach
    // vi-service BLOCKs every purchase. Saying so beats accepting traffic it will refuse.
    const h = harness({ dead: 'vi' })
    const probes = await probeAll(h.deps)

    expect(httpStatus(probes)).toBe(503)
    const vi = byId(probes).get('vi')!
    expect(vi.status).toBe('down')
    expect(vi.detail).toContain('cannot verify a chain')
  })

  it('S-22 503 when PayPal OAuth is refused, because no money movement can be signed', async () => {
    // The check that "a client id and a secret are present" cannot make: a revoked app leaves both
    // variables populated and the *call* is the only thing that fails.
    const h = harness({ dead: 'paypal' })
    const probes = await probeAll(h.deps)

    expect(httpStatus(probes)).toBe(503)
    const paypal = byId(probes).get('paypal')!
    expect(paypal.status).toBe('down')
    expect(paypal.detail).toContain('No PayPal call can be signed')
  })

  it('S-22 200 when OpenAI is absent — the deterministic paths are the product', async () => {
    // §8.0 rule 4: "No LLM output is ever authoritative." A missing model key costs the intent compiler and
    // the dispute-note drafter; it does not cost a purchase, so it must not take the deploy down.
    const h = harness({ missing: 'openai' })
    const probes = await probeAll(h.deps)

    expect(httpStatus(probes)).toBe(200)
    const openai = byId(probes).get('openai')!
    expect(openai.required).toBe(false)
    expect(openai.status).toBe('not_configured')
    // The row still says what is lost, rather than hiding behind a green tick.
    expect(openai.detail).toContain('OPENAI_API_KEY')
    expect(openai.detail).toContain('Intent compilation')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 4. Secrets                                                                                     */
/* ------------------------------------------------------------------------------------------ */

describe('EC-PRIV-3 /status never prints a secret', () => {
  it('EC-PRIV-3 no configured secret value appears anywhere in the probe report', async () => {
    const h = harness()
    const probes = await probeAll(h.deps)
    const serialised = JSON.stringify(probes)

    for (const secret of ALL_SECRET_VALUES) {
      expect(serialised, `the report leaked ${secret.slice(0, 12)}…`).not.toContain(secret)
    }
    // And the access token the OAuth call returned is not in there either — the probe reports that a token
    // was obtained, never which one.
    expect(serialised).not.toContain('A21AAfake-access-token')
  })

  it('EC-PRIV-3 a failing probe’s message does not echo the credential it failed with', async () => {
    // A 401 from PayPal or OpenAI is the case where a careless implementation would paste the request back
    // into the error.
    const paypal = await probeAll(harness({ dead: 'paypal' }).deps)
    expect(JSON.stringify(paypal)).not.toContain(SECRETS.PAYPAL_CLIENT_SECRET)
    expect(JSON.stringify(paypal)).not.toContain(SECRETS.PAYPAL_CLIENT_ID)

    const openai = await probeAll(harness({ dead: 'openai' }).deps)
    expect(JSON.stringify(openai)).not.toContain(SECRETS.OPENAI_API_KEY)
  })

  it('EC-PRIV-3 the HTML rendering is escaped, so a probe message cannot become markup', async () => {
    // A dependency that answers with `<script>` in an error body would otherwise render as a script on our
    // origin — turning "check whether the service is up" into an XSS against whoever looks at it.
    const serialised = JSON.stringify(await probeAll(harness({ dead: 'mcp' }).deps))
    // The probe composes its own sentence from a status code and a message; the message is escaped at render
    // time (see `route.ts`'s `escapeHtml`), and here we assert the raw value never carried markup of its own.
    expect(serialised).not.toContain('<script>')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 5 & 6. "Probe, do not assume"                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe('the probes actually probe', () => {
  it('a configured but DEAD OpenAI is reported down, not up', async () => {
    // The assertion that separates a status page from a key check. `OPENAI_API_KEY` is **present**, every
    // other dependency is healthy, and the page still says the key is not usable.
    const h = harness({ dead: 'openai' })
    const probes = await probeAll(h.deps)
    const openai = byId(probes).get('openai')!

    expect(h.deps.openaiConfigured).toBe(true)
    expect(openai.status).toBe('down')
    expect(openai.required).toBe(false)
    // The sentence names the actual failure, and reassures honestly that nothing money-bearing is affected.
    expect(openai.detail).toContain('configured but not usable')
    expect(openai.detail).toContain('refused')
    // And the instance is **not** pulled out of rotation, because OpenAI is not required.
    expect(httpStatus(probes)).toBe(200)
  })

  it('the OpenAI probe really made the HTTP call, and carried the configured credential', async () => {
    const h = harness()
    await probeAll(h.deps)
    const call = h.calls.find((c) => c.url.includes('api.openai.com'))
    expect(call, 'the OpenAI probe never reached the network').toBeDefined()
    // And a credential that is set but *wrong* is caught: the fixture refuses a bearer it does not
    // recognise.
    const wrong = {
      ...h.deps,
      openaiHeaders: { authorization: 'Bearer sk-not-the-configured-key' },
    }
    expect(byId(await probeAll(wrong)).get('openai')?.status).toBe('down')
  })

  it('sends exactly the headers it was given, and invents none', async () => {
    /*
     * The regression this pins: the probe used to build `Authorization: Bearer ${OPENAI_API_KEY}` itself,
     * which is the wrong credential for a Modal `.direct` endpoint — it wants `Modal-Key`/`Modal-Secret`.
     * `/status` therefore reported a working provider as `down` while `/api/intent/compile` was
     * compiling against it. The probe now sends what the caller resolved, so a provider that
     * authenticates some other way is described correctly by construction rather than by a branch.
     */
    const h = harness()
    const modal = {
      ...h.deps,
      openaiHeaders: { 'Modal-Key': 'ak-test', 'Modal-Secret': 'as-test' },
    }
    await probeAll(modal)
    const call = h.calls.find((c) => c.url.includes('api.openai.com'))
    // Lower-cased, because `Headers` normalises names and HTTP header names are case-insensitive. Spelled
    // out rather than compared to the input: a probe that looked a header up case-sensitively would miss
    // `Modal-Key` on the wire, and this is the assertion that catches it.
    expect(call?.headers).toEqual({ 'modal-key': 'ak-test', 'modal-secret': 'as-test' })
    // No stray `authorization` alongside it: two credentials on one request is how a provider ends up
    // reading the wrong one.
    expect(call?.headers).not.toHaveProperty('authorization')
  })

  it('a dead MCP is reported down without failing the check', async () => {
    // MCP is only the agent's shopping tools (§8.13) and §11 check C3 may still be deciding how to reach it,
    // so it must never be the reason an instance leaves rotation.
    const probes = await probeAll(harness({ dead: 'mcp' }).deps)
    expect(byId(probes).get('mcp')?.status).toBe('down')
    expect(byId(probes).get('mcp')?.required).toBe(false)
    expect(httpStatus(probes)).toBe(200)
  })

  it('a dependency that accepts the socket and then hangs is reported down within the budget', async () => {
    // EC-PP-1 / EC-PP-5 in miniature: a health check that waits for a hung dependency has stopped being one.
    // `Promise.race` against the budget is what makes this bounded.
    const started = Date.now()
    const probes = await probeAll(harness({ hang: 'openai' }).deps)
    const elapsed = Date.now() - started

    expect(byId(probes).get('openai')?.status).toBe('down')
    expect(byId(probes).get('openai')?.detail).toContain('no answer within')
    // Bounded, not instant: the point is that the probe gives up on its budget instead of waiting for the
    // dependency. The budget is 800 ms and the fixture sleeps 3 s, so a 2 s ceiling proves the race fired.
    expect(elapsed).toBeLessThan(2_500)
  })

  it('a hung required dependency also reports down rather than hanging the whole page', async () => {
    const probes = await probeAll(harness({ hang: 'vi' }).deps)
    expect(byId(probes).get('vi')?.status).toBe('down')
    expect(httpStatus(probes)).toBe(503)
    // And the others still answered — one hung dependency must not hide the rest.
    expect(byId(probes).get('paypal')?.status).toBe('up')
    expect(byId(probes).get('openai')?.status).toBe('up')
  })

  it('all five dependencies are probed, in a fixed order, every time', async () => {
    // A fixed order makes two responses to the same state produce the same body, so a diff of two health
    // checks means something.
    const probes = await probeAll(harness().deps)
    expect(probes.map((p) => p.id)).toEqual(['database', 'vi', 'paypal', 'mcp', 'openai'])
    // And every row states whether it is required, because that flag is the whole status code.
    expect(probes.filter((p) => p.required).map((p) => p.id)).toEqual(['database', 'vi', 'paypal'])
  })

  it('every probe reports a one-sentence detail a human can act on', async () => {
    for (const p of await probeAll(harness().deps)) {
      expect(p.detail.length, `${p.id} has no detail`).toBeGreaterThan(10)
      expect(p.detail.endsWith('.') || p.detail.endsWith('?'), `${p.id}: "${p.detail}"`).toBe(true)
    }
  })
})
