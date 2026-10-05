/**
 * **Check 4 must send a chain.** The `l1: ''` / `l2: ''` regression, pinned at the layer that hid it.
 *
 * ## The defect this file exists for
 *
 * `checks.ts::check4ChainVerify` used to build its `/v1/verify` request with **empty strings** for `l1`
 * and `l2`. `verifyRequestSchema` (`vi-client/src/types.ts`) declares both as `boundedString(…)`, i.e.
 * `z.string().min(1)`, and `ViClient.verify` validates the request **before the first fetch**
 * (`client.ts::call`, line 714). So:
 *
 * ```
 * check  4  passed=false code=CHAIN_VERIFY :: verify call failed: CS_VALIDATION
 * ```
 *
 * with **zero** HTTP requests issued. Every Gate decision was `BLOCK`; no PayPal order could ever be
 * created. Worse, `disclosed.l2` was therefore never read, so `state.signedConstraints` stayed empty,
 * `state.pending` stayed empty, and **D19's obligation gate never fired** — the signed-budget fix was
 * correct in code and inert in production. `check 8 passed=true` in the very same decision record, having
 * compared the cart against `budget_accounts.cap_minor` and never consulting the buyer's signature. That
 * is QA-gate-1, still reachable.
 *
 * ## Why no test caught it
 *
 * `createInMemoryGateWorld` implemented `verify` as a bare stub, so every gate test injected a port that
 * answers `chain_valid: true` to anything — including an empty chain. **The production binding was never
 * executed.** A suite of 204 tests, a thousand-mutation fuzz and a twenty-way race, all green, all blind
 * to a defect that made the product non-functional.
 *
 * So this file exercises the **real** `ViClient` over a **real socket**, and asserts on the bytes that
 * actually left the process. That is the only assertion that could have failed here: a stub cannot fail,
 * and the failure mode being guarded is precisely "the request never got far enough for the stub's answer
 * to matter".
 *
 * ## The three things asserted
 *
 * 1. **A fetch happened.** `fetchCount > 0`. This is the assertion whose absence hid the defect — the
 *    symptom was "no request was made", and no test was counting requests.
 * 2. **The request is valid.** The captured body parses through `verifyRequestSchema`, the exact schema
 *    the production client parses it through.
 * 3. **`l1` and `l2` are non-empty**, and are the bytes held in `l1_credentials.sd_jwt` and
 *    `mandates.l2_serialized` — not merely "not blank", but *this mandate's* tokens, so a check cannot
 *    pass by sending some other chain's token.
 *
 * The response served is the **committed real capture** (`fixtures/vi-verify-budget-capture.json`,
 * byte-for-byte what `apps/vi` returned), so the assertion that `signedConstraints` is populated and the
 * budget is read from the token is made against genuine vi-service output rather than a hand-built object.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'

import { csError, err, fixedClock, ok } from '@countersign/core'
import { ViClient, verifyRequestSchema, type VerifyResponse } from '@countersign/vi-client'
import { describe, expect, it } from 'vitest'

import { evaluate } from '../src/evaluate'
import type { GateDecision, GateDeps } from '../src/types'
import { BUDGET_CONSTRAINT_TYPE, CONSTRAINT_SOURCE } from '../src/signed-constraints'
import { CART_MINOR, DEVICE_ID, NOW_SEC, WALLET_ID, input, makeWorld, withDeps } from './fixtures'

/* ------------------------------------------------------------------------------------------ */
/* A real vi-service, on a real socket                                                           */
/* ------------------------------------------------------------------------------------------ */

/** One request as the server received it. The only thing that is ever asserted against. */
interface CapturedRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
  readonly body: unknown
}

interface FakeViService {
  readonly baseUrl: string
  readonly requests: CapturedRequest[]
  /** The fetch count, named so an assertion reads as the thing it checks. */
  readonly fetchCount: () => number
  readonly close: () => Promise<void>
}

/**
 * An `http.Server` that answers `/v1/verify` with `response` and records what it was sent.
 *
 * A real socket rather than a `fetchImpl` stub on purpose: `ViClient` wraps whatever `fetch` it is
 * given, and a fake transport is one more place for the request to be quietly reshaped. Over TCP the only
 * thing between `checks.ts` and the server's `req` is Node's own HTTP stack.
 */
async function startViService(response: unknown): Promise<FakeViService> {
  const requests: CapturedRequest[] = []

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers['authorization'],
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    fetchCount: () => requests.length,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  }
}

/** A `ViClient` with no injected transport, so the global `fetch` really does go out over TCP. */
function realClient(baseUrl: string): ViClient {
  return new ViClient({
    baseUrl,
    token: 'test-service-token',
    clock: fixedClock(NOW_SEC),
    // No retries: a failure must be reported as the failure it is, not retried into a confusing one.
    maxRetries: 0,
    timeoutMs: 5_000,
  })
}

/** The committed capture: a real `/v1/verify` response, signed by the pinned library commit. */
const capture = JSON.parse(
  readFileSync(new URL('./fixtures/vi-verify-budget-capture.json', import.meta.url), 'utf8'),
) as {
  readonly verify_response: VerifyResponse
  readonly _meta: { readonly signed_budget_max_minor: number }
}

type World = Awaited<ReturnType<typeof makeWorld>>

/** Exactly the port check 4 calls. Named once so every spy in this file has the production signature. */
type VerifyPort = GateDeps['verify']

function row(decision: GateDecision, n: number) {
  const found = decision.checks.find((c) => c.n === n)
  if (!found) throw new Error(`no check ${n} in the decision`)
  return found
}

/** Decide a world with one port replaced, and fail loudly rather than returning a `Result`. */
async function decide(world: World, verify: VerifyPort): Promise<GateDecision> {
  const result = await evaluate(input(), withDeps(world, { verify }))
  if (!result.ok)
    throw new Error(`evaluate() failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/* ------------------------------------------------------------------------------------------ */
/* 0 — Why there is no "send it anyway" answer                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * The precondition, asserted through the real client rather than read off the schema.
 *
 * An empty `l1`/`l2` is not a *tolerated* input, it is a **refused** one — and refused before any network
 * traffic, so the failure a production incident would show is `CS_VALIDATION` with a fetch count of
 * **zero**. This test is the reason the fix is "obtain the tokens or BLOCK": there is no value to fall
 * back to, so the only honest choices are the real tokens and a refusal.
 */
describe('an empty l1/l2 is refused by the real client, before any fetch', () => {
  it('returns CS_VALIDATION and makes zero requests — the symptom this defect produced', async () => {
    const service = await startViService(capture.verify_response)
    try {
      const verdict = await realClient(service.baseUrl).verify({
        l1: '',
        l2: '',
        l3a: 'a.b.c',
        l3b: 'd.e.f',
        strict: true,
      })

      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.error.code).toBe('CS_VALIDATION')
      // The decisive one: no HTTP request was made, so a test that only asserted on the returned error
      // could never distinguish "vi said no" from "we never asked".
      expect(
        service.fetchCount(),
        'a client-side validation failure must not have reached the network',
      ).toBe(0)
    } finally {
      await service.close()
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 1 — THE REGRESSION TEST                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * **The request check 4 builds is one the real `ViClient` will actually send.**
 *
 * Everything the stub world used to hide is asserted at once:
 *
 * - `fetchCount === 1` — the request left this process;
 * - the captured body passes `verifyRequestSchema` — the same schema the client validated against;
 * - `l1` and `l2` are non-empty and are *this mandate's* tokens;
 * - check 4 passed on a real vi verdict, and `signedConstraints` came out of a real `disclosed.l2`.
 *
 * Against the pre-fix code this fails three ways at once: `fetchCount === 0`, `verdict.ok === false` with
 * `CS_VALIDATION`, and check 4 `passed: false`. The test names the tokens rather than asserting
 * "not empty" alone so that a future check which sends *some* chain cannot pass by being merely valid.
 */
describe('check 4 sends a real chain through the real ViClient', () => {
  it('issues exactly one fetch whose body satisfies verifyRequestSchema, with non-empty l1 and l2', async () => {
    const service = await startViService(capture.verify_response)
    try {
      const client = realClient(service.baseUrl)
      const world = await makeWorld({ l1: { sd_jwt: 'the-l1-sd-jwt-for-this-device' } })
      const mandateL2 = world.mandate.l2_serialized
      expect(mandateL2.length).toBeGreaterThan(0)

      const decision = await decide(world, (request) => client.verify(request))

      // (1) A request actually happened. This is the assertion whose absence let the defect ship.
      expect(
        service.fetchCount(),
        'check 4 must issue a real HTTP request; 0 means the request was refused client-side, which is ' +
          'the exact production failure this file pins',
      ).toBe(1)

      const sent = service.requests[0]!
      expect(sent.method).toBe('POST')
      expect(sent.url).toBe('/v1/verify')
      // The route is bearer-authenticated in production, so a Gate wired with an empty token would get a
      // 401 and read as "vi is down". Cheap to assert, and it is a wiring mistake worth catching.
      expect(sent.authorization).toBe('Bearer test-service-token')

      // (2) The bytes that left are valid *for the schema the client validates against*.
      const parsed = verifyRequestSchema.safeParse(sent.body)
      expect(
        parsed.success,
        `the request check 4 built failed verifyRequestSchema: ${JSON.stringify(
          parsed.success ? [] : parsed.error.issues.slice(0, 5),
        )}`,
      ).toBe(true)

      // (3) Non-empty, and this mandate's own tokens.
      const body = sent.body as Record<string, unknown>
      expect(typeof body['l1']).toBe('string')
      expect(typeof body['l2']).toBe('string')
      expect(body['l1'] as string).not.toBe('')
      expect(body['l2'] as string).not.toBe('')
      expect(body['l1']).toBe('the-l1-sd-jwt-for-this-device')
      expect(body['l2']).toBe(mandateL2)
      expect(body['strict']).toBe(true)

      // And the verdict came back through the real response schema, so the decision was made from a real
      // vi-service answer rather than from a fixture of one.
      expect(decision.checks.length).toBe(12)
      expect(row(decision, 4).passed).toBe(true)
      expect(row(decision, 4).detail).toContain('chain valid')
    } finally {
      await service.close()
    }
  })

  it('reads the signed budget out of the real disclosed.l2, so D19 is live rather than inert', async () => {
    // The compounding half of the defect, asserted separately because it is the half that silently
    // disarmed the signed-budget fix: with `disclosed.l2` never read, `pendingNetworkEnforcement` was
    // empty and the obligation gate could not fire, so `check 8` fell back to `budget_accounts.cap_minor`.
    const service = await startViService(capture.verify_response)
    try {
      const client = realClient(service.baseUrl)
      const world = await makeWorld({ l1: { sd_jwt: 'the-l1-sd-jwt-for-this-device' } })

      const decision = await decide(world, (request) => client.verify(request))

      // The obligation vi reported is on the decision record.
      expect(decision.pendingNetworkEnforcement).toContain(BUDGET_CONSTRAINT_TYPE)

      // And check 8 read the buyer's ceiling out of the chain, naming the token as the source. The
      // capture's ceiling is $130.00 and the fixture's account cap is $130.00 too, so the *source* is the
      // assertion — a check 8 that said "budget_accounts.cap_minor" here is the QA-gate-1 shape.
      const detail = row(decision, 8).detail ?? ''
      expect(detail).toContain('the signed L2')
      expect(detail).toContain(String(capture._meta.signed_budget_max_minor))

      // `signedConstraints` itself, reached through `evaluate` → check 4 → `disclosedConstraints`.
      const check11 = row(decision, 11)
      expect(check11.passed).toBe(true)
      expect(check11.detail).toContain(CONSTRAINT_SOURCE.SIGNED_L2)
      expect(check11.detail).toContain('D19 obligation discharged')
    } finally {
      await service.close()
    }
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 2 — Fail closed                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * A missing token is a **real absence**, and each one is reported as its own fact.
 *
 * The detail has to say *which*, because the two have different fixes and a generic "verify failed" is
 * what made this expensive to diagnose in the first place: `CS_VALIDATION` on `l1`/`l2` reads like a
 * malformed token when in fact no token had been sent.
 *
 * Every case below also asserts that `verify` was **never called** — a Gate that refused for want of a
 * token but still asked vi to verify something would be a different bug, and an easy one to reintroduce.
 */
describe('a missing chain token BLOCKs, names itself, and never reaches /v1/verify', () => {
  it('mandates.l2_serialized is empty → BLOCK naming the column, and no verify call', async () => {
    const world = await makeWorld({ mandate: { l2_serialized: '' } })
    const called: number[] = []
    const spy: VerifyPort = async () => {
      called.push(1)
      return ok(capture.verify_response)
    }

    const decision = await decide(world, spy)

    expect(decision.decision).toBe('BLOCK')
    expect(called, 'check 4 must not ask vi to verify a chain it does not hold').toHaveLength(0)

    const check4 = row(decision, 4)
    expect(check4.passed).toBe(false)
    // Blocking, not `notApplicable`: §8.10's `notApplicable` is non-blocking, and an unverifiable chain is
    // the definition of "there was something to enforce and we could not enforce it".
    expect(check4.notApplicable).toBeUndefined()
    expect(check4.detail).toContain('l2_serialized')
    expect(check4.detail).toContain('empty')
    expect(decision.reasons.map((r) => r.code)).toContain('VI_CHAIN_INVALID')
    // The buyer-facing copy says nothing was charged, and does not blame the token.
    const reason = decision.reasons.find((r) => r.code === 'VI_CHAIN_INVALID')!
    expect(reason.userMessage).toContain('nothing was charged')
  })

  it('a whitespace-only l2_serialized is also a refusal, not a token', async () => {
    // The column is `NOT NULL` but nothing constrains its contents, so `'\n'` is reachable. Sending it
    // would be sending a non-token, and `boundedString` would refuse it anyway — as `CS_VALIDATION`,
    // which says nothing useful.
    const world = await makeWorld({ mandate: { l2_serialized: '   \n ' } })

    const decision = await decide(world, async () => ok(capture.verify_response))

    expect(decision.decision).toBe('BLOCK')
    expect(row(decision, 4).detail).toContain('l2_serialized')
  })

  it('no l1_credentials row for the device×wallet → BLOCK naming the lookup, and no verify call', async () => {
    const world = await makeWorld({ l1: null })
    const called: number[] = []
    const spy: VerifyPort = async () => {
      called.push(1)
      return ok(capture.verify_response)
    }

    const decision = await decide(world, spy)

    expect(decision.decision).toBe('BLOCK')
    expect(called, 'check 4 must not ask vi to verify a chain it does not hold').toHaveLength(0)

    const detail = row(decision, 4).detail ?? ''
    expect(detail).toContain('l1_credentials')
    // It names the lookup, so an operator knows which pair of keys to go and look at.
    expect(detail).toContain(DEVICE_ID)
    expect(detail).toContain(WALLET_ID)
    // And it must NOT be the L2 message: "which is missing" has to be distinguishable.
    expect(detail).not.toContain('l2_serialized')
  })

  it('an empty sd_jwt on an existing row → BLOCK naming the column', async () => {
    const world = await makeWorld({ l1: { sd_jwt: '' } })

    const decision = await decide(world, async () => ok(capture.verify_response))

    expect(decision.decision).toBe('BLOCK')
    const detail = row(decision, 4).detail ?? ''
    expect(detail).toContain('sd_jwt')
    expect(detail).toContain(DEVICE_ID)
  })

  it('a repository failure is reported as that failure, not as a missing token', async () => {
    // The lookup itself failing (a dropped connection, a revoked permission) is a different fact from "no
    // such row", and it arrives as its own `CsError`. Passing its code through keeps a database outage
    // from being reported as a buyer problem — and it is the only branch of `chainTokens` that does not
    // answer `VI_CHAIN_INVALID`.
    const world = await makeWorld()
    const deps = withDeps(world, {
      findL1ForDeviceWallet: async () =>
        err(csError('CS_INTERNAL', 'could not reach the database', { table: 'l1_credentials' })),
    })
    const called: number[] = []
    const result = await evaluate(input(), {
      ...deps,
      verify: async () => (called.push(1), ok(capture.verify_response)),
    })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

    expect(result.value.decision).toBe('BLOCK')
    expect(called).toHaveLength(0)
    expect(result.value.reasons.map((r) => r.code)).toContain('CS_INTERNAL')
    // The message keeps the lookup in it, so the outage is attributable from the decision record.
    expect(result.value.reasons.find((r) => r.code === 'CS_INTERNAL')!.message).toContain(DEVICE_ID)
  })

  it("the L1 lookup is scoped to the mandate's own device AND wallet", async () => {
    // §7.2's unique index is on `(device_id, wallet_id)`, so a lookup that honoured only one half would
    // let one device's credential stand in for another's. Asserted on the *arguments*, because a
    // permissive binding is invisible from the decision.
    const world = await makeWorld()
    const seen: Array<[string, string]> = []
    const result = await evaluate(
      input(),
      withDeps(world, {
        findL1ForDeviceWallet: async (deviceId, walletId) => {
          seen.push([deviceId, walletId])
          return ok({ sd_jwt: 'the-l1' })
        },
      }),
    )
    if (!result.ok) throw new Error(result.error.message)

    expect(seen).toEqual([[DEVICE_ID, WALLET_ID]])
  })

  it('a mandate row that does not exist leaves check 4 notApplicable — and the decision still BLOCKs', async () => {
    // Check 1 could not resolve a mandate, so there is no stored L2 and no device to resolve an L1 for.
    // Reporting check 4 as `notApplicable` is right (it had nothing to enforce) and non-blocking, which is
    // safe *only* because check 1 already blocked. This is the one branch where check 4 says "nothing to
    // enforce" rather than "I could not enforce it", and the distinction is worth pinning: a Gate that
    // reported a missing mandate as an unverifiable chain would put a false `VI_CHAIN_INVALID` in a signed
    // record for what is really a stale `mandateId`.
    const world = await makeWorld()
    const called: number[] = []
    const result = await evaluate(
      input(),
      withDeps(world, {
        mandate: async () => ok(undefined),
        verify: async () => (called.push(1), ok(capture.verify_response)),
      }),
    )
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)

    expect(result.value.decision).toBe('BLOCK')
    expect(called).toHaveLength(0)
    expect(row(result.value, 4).notApplicable).toBe(true)
    expect(row(result.value, 4).detail).toContain('check 1')
    // `chainValid` stays at its default, so the signed record cannot claim a verified chain.
    expect(result.value.pendingNetworkEnforcement).toEqual([])
  })

  it('a revoked mandate still has its row, so check 4 refuses on the chain, not on the absence', async () => {
    // The control for the case above. `REVOKED` resolves fine — the row exists, `l2_serialized` is there —
    // so check 4 is evaluable and must be *evaluated*. If it reported `notApplicable` here, the record
    // would say "the chain was fine, the mandate was revoked" when in fact nothing was verified.
    const world = await makeWorld({ mandate: { status: 'REVOKED' } })

    const decision = await decide(world, async () => ok(capture.verify_response))

    expect(decision.decision).toBe('BLOCK')
    expect(row(decision, 4).notApplicable).toBeUndefined()
    expect(row(decision, 1).detail).toContain('REVOKED')
  })
})

/* ------------------------------------------------------------------------------------------ */
/* 3 — The double itself, so no future test is blind this way again                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * `createInMemoryGateWorld`'s `verify` now runs `verifyRequestSchema`, so the *stub world* would also
 * refuse an empty chain.
 *
 * This is the structural half of the fix. The first test above is the behavioural half — one test that
 * would have caught the defect. This one says the other 204 tests can no longer be blind to it: a Gate
 * that builds a malformed `/v1/verify` request fails **every** gate test rather than none, which is the
 * difference between a defect that ships and one that cannot.
 */
describe('the in-memory verify port validates the request like the real client', () => {
  it('refuses a chain whose l1 is empty, with CS_VALIDATION and no verdict', async () => {
    const world = await makeWorld()
    const verdict = await world.deps.verify({
      l1: '',
      l2: 'some-l2',
      l3a: 'a.b.c',
      l3b: 'd.e.f',
      strict: true,
    })

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.error.code).toBe('CS_VALIDATION')
    // The message names the field, so the failure is diagnosable from the decision record alone.
    expect(verdict.error.message).toContain('l1')
  })

  it('accepts the chain the Gate actually builds from this world', async () => {
    // The control for the case above. Without it, "always refuses" would satisfy it, and the gate suite
    // would be silently broken in the other direction — a Gate that can never verify anything is the same
    // production failure wearing a different hat.
    const world = await makeWorld()
    const decision = await decide(world, world.deps.verify)

    expect(decision.decision).toBe('ALLOW')
    expect(row(decision, 4).passed).toBe(true)
    expect(world.snapshot().reserved).toBe(CART_MINOR)
  })
})
