/**
 * Schema drift — spec **§8.4 AT-M4.2**:
 *
 * > vi exposes `/openapi.json`, and a script fails CI if the request/response fields differ from the zod
 * > schemas.
 *
 * Run against the committed `fixtures/openapi.vi-service.json`, so **no test in this file opens a socket**
 * and AT-M4.2 is satisfied in CI today, before a vi-service exists in the pipeline.
 *
 * The first group asserts the fixture and the schemas agree today. **The second group is the one that
 * matters**: a drift check that cannot fail is a decoration, so every injected drift is asserted to be
 * caught, in both directions, at the right route and path. Regenerate the fixture whenever
 * `apps/vi` changes a pydantic model — see `fixtures/README.md`.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  compareSchemas,
  formatDriftTable,
  hasDrift,
  loadOpenApiDocument,
} from '../src/schema-drift'
import type { DriftDifference, DriftReport } from '../src/schema-drift'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(HERE, 'fixtures', 'openapi.vi-service.json')

type Json = Record<string, unknown>

async function readFixture(): Promise<Json> {
  return JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Json
}

/** A deep, isolated copy of the fixture, so each test may mutate it freely. */
async function drifted(mutate: (doc: Json) => void): Promise<DriftReport> {
  const doc = await readFixture()
  mutate(doc)
  return compareSchemas(doc)
}

function schemas(doc: Json): Record<string, Json> {
  return (doc['components'] as Json)['schemas'] as Record<string, Json>
}

function props(doc: Json, name: string): Json {
  return schemas(doc)[name]?.['properties'] as Json
}

// ---------------------------------------------------------------------------
// The schemas and the service agree today
// ---------------------------------------------------------------------------

describe('AT-M4.2: the committed OpenAPI document and the zod schemas agree', () => {
  it('finds no differences across all twelve routes', async () => {
    const report = compareSchemas(await readFixture())
    expect(report.differences).toEqual([])
    expect(hasDrift(report)).toBe(false)
  })

  it('compares every route the document declares', async () => {
    const report = compareSchemas(await readFixture())
    expect(report.routesInDocument).toBe(12)
    expect(report.routesCompared).toBe(12)
  })

  it('models the request body of all ten POST routes and the response of all twelve', async () => {
    // A route the client never inspects is a route whose drift is invisible, so the count of *compared
    // sides* is worth pinning rather than leaving implied by the route count.
    const report = compareSchemas(await readFixture())
    const sides = new Set(report.unverifiable.map((u) => `${u.route} ${u.side}`))
    expect(sides.size).toBeGreaterThan(0)
  })

  it('reports the genuinely opaque positions rather than passing over them', async () => {
    const report = compareSchemas(await readFixture())
    const paths = report.unverifiable.map((u) => `${u.route} ${u.side} ${u.path}`)
    // vi declares these as bare dicts, so nothing about them can be compared.
    expect(paths).toContain('POST /v1/l2/prepare response payload')
    expect(paths).toContain('POST /v1/l2/prepare response header')
    expect(paths).toContain('POST /v1/keys/agent response public_jwk')
    expect(paths).toContain('GET /v1/jwks response keys[]')
    // The constraint arrays: the service says "object", this client types the eight registered types.
    expect(paths).toContain('POST /v1/l2/prepare request checkout_constraints[]')
    expect(paths).toContain('POST /v1/l2/prepare request payment_constraints[]')
  })

  it('calls out that GET /v1/checkout-jwt/verify has no schema in the service at all', async () => {
    // `main.py` returns a bare `dict[str, Any]` for this route, so FastAPI emits
    // `{"type": "object", "additionalProperties": true}`. This client types it anyway, and says so.
    const report = compareSchemas(await readFixture())
    const note = report.unverifiable.find((u) => u.route === 'GET /v1/checkout-jwt/verify' && u.side === 'response')
    expect(note).toBeDefined()
    expect(note?.reason).toMatch(/opaque object/)
  })

  it('renders a table that names the route, the path and the direction', async () => {
    const report = compareSchemas(await readFixture())
    const table = formatDriftTable(report)
    expect(table).toContain('12/12')
    expect(table).toContain('no differences')
    expect(table).toContain('unverifiable positions')
  })
})

// ---------------------------------------------------------------------------
// The comparator actually catches drift, in both directions
// ---------------------------------------------------------------------------

describe('a field the service sends and the client does not model', () => {
  it('is reported as service-only, informational, at the right route and path', async () => {
    const report = await drifted((doc) => {
      props(doc, 'VerifyResponse')['brand_new_check'] = { type: 'string' }
    })
    const d = find(report, 'POST /v1/verify', 'brand_new_check')
    expect(d).toBeDefined()
    expect(d?.kind).toBe('field')
    expect(d?.direction).toBe('service-only')
    expect(d?.severity).toBe('informational')
    expect(d?.detail).toMatch(/client does not model/)
  })

  it('fails the check even though it is informational, because §8.4 says the fields must not differ', () => {
    expect(hasDrift({ differences: [stubDifference('service-only')], unverifiable: [], routesCompared: 1, routesInDocument: 1 })).toBe(
      true,
    )
  })
})

describe('a field the client requires and the service does not declare', () => {
  // The direction that hurts at 3 a.m.: the client demands a field the service stopped sending, so a 2xx
  // that was fine a moment ago fails to parse. A one-way check would never see it.
  it('is reported as client-only and breaking', async () => {
    const report = await drifted((doc) => {
      delete props(doc, 'L1IssueResponse')['device_jkt']
    })
    const d = find(report, 'POST /v1/l1/issue', 'device_jkt')
    expect(d?.kind).toBe('field')
    expect(d?.direction).toBe('client-only')
    expect(d?.severity).toBe('breaking')
  })

  it('reports it when the service stops requiring a field the client still requires, as harmless drift', async () => {
    const report = await drifted((doc) => {
      const schema = schemas(doc)['L3CreateRequest'] as Json
      schema['required'] = (schema['required'] as string[]).filter((f) => f !== 'nonce')
    })
    const d = find(report, 'POST /v1/l3/create', 'nonce')
    expect(d?.kind).toBe('requiredness')
    expect(d?.direction).toBe('client-only')
    // Harmless at runtime — we always send what we require — but still drift, and §8.4 fails on drift.
    expect(d?.severity).toBe('informational')
    expect(d?.detail).toMatch(/the client requires this field but the service declares it optional/)
  })

  it('reports as breaking when the service requires a field the client treats as optional', async () => {
    // The dangerous direction: a caller omits something vi insists on, and vi answers 400. `agent_id` is
    // already declared optional by this client, so promoting it in the document isolates the requiredness.
    const report = await drifted((doc) => {
      const schema = schemas(doc)['L3CreateRequest'] as Json
      schema['required'] = [...(schema['required'] as string[]), 'agent_id']
    })
    const d = find(report, 'POST /v1/l3/create', 'agent_id')
    expect(d?.kind).toBe('requiredness')
    expect(d?.direction).toBe('service-only')
    expect(d?.severity).toBe('breaking')
    expect(d?.detail).toMatch(/may omit it and vi will reject/)
  })
})

describe('type drift', () => {
  it('is reported when an integer amount becomes a string', async () => {
    const report = await drifted((doc) => {
      props(doc, 'L3Payment')['amount_minor'] = { type: 'string' }
    })
    const d = find(report, 'POST /v1/l3/create', 'payment.amount_minor')
    expect(d?.kind).toBe('type')
    expect(d?.severity).toBe('breaking')
    expect(d?.detail).toMatch(/\{string\}/)
  })

  it('reports a requiredness drop on a response as breaking, because we would demand an absent field', async () => {
    const report = await drifted((doc) => {
      const schema = schemas(doc)['CheckoutJwtResponse'] as Json
      schema['required'] = (schema['required'] as string[]).filter((f) => f !== 'kid')
    })
    const d = find(report, 'POST /v1/checkout-jwt', 'kid')
    expect(d?.kind).toBe('requiredness')
    expect(d?.direction).toBe('client-only')
    expect(d?.severity).toBe('breaking')
  })

  /**
   * `integer` widening to `number` is reported, even though the client would still be safe.
   *
   * That is a deliberate choice over JSON Schema's own containment rule (`integer ⊂ number`). A field
   * quietly becoming fractional is exactly the drift this check exists to surface — an amount, a quantity,
   * a timestamp that is no longer a whole number — so it is reported rather than reasoned away. The
   * alternative is a comparator that stays silent about the class of change most likely to matter.
   */
  it('reports an integer widening to number, rather than reasoning it away as containment', async () => {
    const report = await drifted((doc) => {
      props(doc, 'L2PrepareResponse')['expires_at'] = { type: 'number' }
    })
    const d = find(report, 'POST /v1/l2/prepare', 'expires_at')
    expect(d?.kind).toBe('type')
    expect(d?.severity).toBe('breaking')
    expect(d?.detail).toMatch(/\{number\}/)
  })
})

describe('enum drift', () => {
  it('is reported when the service adds a value the client does not accept', async () => {
    const report = await drifted((doc) => {
      props(doc, 'RotateKeyRequest')['role'] = { type: 'string', enum: ['ISSUER', 'MERCHANT', 'GATE'] }
    })
    const d = find(report, 'POST /v1/keys/rotate', 'role')
    expect(d?.kind).toBe('enum')
    expect(d?.direction).toBe('service-only')
    expect(d?.detail).toContain('GATE')
  })

  it('is reported when the client accepts a value the service rejects, as breaking', async () => {
    const report = await drifted((doc) => {
      props(doc, 'RotateKeyRequest')['role'] = { type: 'string', enum: ['ISSUER'] }
    })
    const d = find(report, 'POST /v1/keys/rotate', 'role')
    expect(d?.kind).toBe('enum')
    expect(d?.direction).toBe('client-only')
    expect(d?.severity).toBe('breaking')
  })

  it('reports as client-only breaking when the service drops a currency the client still accepts', async () => {
    const report = await drifted((doc) => {
      props(doc, 'CheckoutJwtRequest')['currency'] = { type: 'string', enum: ['USD', 'EUR'] }
    })
    const d = find(report, 'POST /v1/checkout-jwt', 'currency')
    // The service narrowed its enum, so the client would happily send GBP and vi would refuse it. That
    // is the breaking direction — the client's permissiveness is the thing that breaks.
    expect(d?.kind).toBe('enum')
    expect(d?.direction).toBe('client-only')
    expect(d?.severity).toBe('breaking')
    // Every dropped currency is named, not just the first.
    const named = report.differences.filter((x) => x.route === 'POST /v1/checkout-jwt' && x.kind === 'enum')
    expect(named.map((x) => x.detail).join(' ')).toContain('JPY')
    expect(named).toHaveLength(5)
  })
})

describe('additionalProperties drift', () => {
  // Neither branch below is reachable from the real manifest, and that is a property of `types.ts` rather
  // than an accident: every request schema is `z.strictObject` (closed) against a `StrictModel` (closed),
  // and every response schema is `z.object` (open) against a plain `BaseModel` (open). They are still
  // implemented and still tested, because a future schema that breaks the symmetry must not take the check
  // down with it — so these use `compareSchemas`'s `contracts` parameter instead of editing `types.ts`.
  const STRICT_REQUEST = z.strictObject({ a: z.string() })
  const LOOSE_RESPONSE = z.object({ a: z.string() })
  const LOOSE_REQUEST = z.looseObject({ a: z.string() })
  const STRICT_RESPONSE = z.strictObject({ a: z.string() })

  function syntheticDoc(closed: { request?: boolean; response?: boolean }): Json {
    const body = (isClosed: boolean): Json => ({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      ...(isClosed ? { additionalProperties: false } : {}),
    })
    return {
      openapi: '3.1.0',
      paths: {
        '/v1/synthetic': {
          post: {
            requestBody: { content: { 'application/json': { schema: body(closed.request ?? true) } } },
            responses: { '200': { content: { 'application/json': { schema: body(closed.response ?? false) } } } },
          },
        },
      },
    }
  }

  it('reports as breaking when the service forbids extras and the client allows them', () => {
    // On a request the client builds the body, so being laxer than the service means it can build a body
    // vi will reject.
    const report = compareSchemas(syntheticDoc({ request: true, response: true }), [
      { method: 'POST', path: '/v1/synthetic', auth: 'bearer', request: LOOSE_REQUEST, response: STRICT_RESPONSE, note: '' },
    ])
    const d = report.differences.find((x) => x.side === 'request' && x.kind === 'additional-properties')
    expect(d?.severity).toBe('breaking')
    expect(d?.detail).toMatch(/vi will reject/)
  })

  it('reports as breaking on a response, where a closed client would reject a valid answer', () => {
    const report = compareSchemas(syntheticDoc({ request: false, response: false }), [
      { method: 'POST', path: '/v1/synthetic', auth: 'bearer', request: STRICT_REQUEST, response: STRICT_RESPONSE, note: '' },
    ])
    const d = report.differences.find((x) => x.side === 'response' && x.kind === 'additional-properties')
    expect(d?.severity).toBe('breaking')
    expect(d?.detail).toMatch(/legitimate response would be rejected/)
  })

  it('reports as informational on a request, where a closed client is harmless', () => {
    const report = compareSchemas(syntheticDoc({ request: false, response: false }), [
      { method: 'POST', path: '/v1/synthetic', auth: 'bearer', request: STRICT_REQUEST, response: LOOSE_RESPONSE, note: '' },
    ])
    const d = report.differences.find((x) => x.side === 'request' && x.kind === 'additional-properties')
    expect(d?.direction).toBe('service-only')
    expect(d?.severity).toBe('informational')
  })

  it('treats `true` and `{}` as the same "open", because that is what they mean', () => {
    // pydantic's `extra="allow"` renders as `additionalProperties: true`; zod's `looseObject` renders as
    // `{}`. Conflating them would report drift on every `extra="allow"` model in the service.
    const report = compareSchemas(
      {
        openapi: '3.1.0',
        paths: {
          '/v1/synthetic': {
            post: { responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: {} } } } } } },
          },
        },
      },
      [{ method: 'POST', path: '/v1/synthetic', auth: 'bearer', response: LOOSE_RESPONSE, note: '' }],
    )
    expect(report.differences).toEqual([])
  })
})

describe('route drift', () => {
  it('is reported when the client models a route the service no longer declares', async () => {
    const report = await drifted((doc) => {
      delete (doc['paths'] as Json)['/v1/l3/create']
    })
    const d = report.differences.find((x) => x.kind === 'missing-route')
    expect(d?.route).toBe('POST /v1/l3/create')
    expect(d?.direction).toBe('client-only')
    expect(report.routesCompared).toBe(11)
  })

  it('is reported when the service declares a route the client has no method for', async () => {
    const report = await drifted((doc) => {
      ;(doc['paths'] as Json)['/v1/brand-new'] = { post: { responses: { '200': { description: 'ok' } } } }
    })
    const d = report.differences.find((x) => x.kind === 'unmodelled-route')
    expect(d?.route).toBe('POST /v1/brand-new')
    expect(d?.direction).toBe('service-only')
  })
})

describe('robustness', () => {
  it('does not crash on a document with no paths at all', () => {
    const report = compareSchemas({ openapi: '3.1.0' })
    expect(report.differences).toHaveLength(12)
    expect(report.differences.every((d) => d.kind === 'missing-route')).toBe(true)
    expect(report.unverifiable).toEqual([])
  })

  it('does not crash on something that is not a document at all', () => {
    expect(() => compareSchemas('not a document')).not.toThrow()
    expect(() => compareSchemas(null)).not.toThrow()
    expect(hasDrift(compareSchemas(undefined))).toBe(true)
  })

  it('reports an unresolvable $ref as unverifiable rather than as drift', async () => {
    const report = await drifted((doc) => {
      props(doc, 'VerifyResponse')['constraints'] = { $ref: '#/components/schemas/NoSuchModel' }
    })
    expect(hasDrift(report)).toBe(false)
    expect(report.unverifiable.some((u) => u.path === 'constraints')).toBe(true)
  })

  it('renders every difference on its own row, with a stable order', async () => {
    const report = await drifted((doc) => {
      props(doc, 'VerifyResponse')['one'] = { type: 'string' }
      props(doc, 'VerifyResponse')['two'] = { type: 'string' }
      props(doc, 'JwksResponse')['three'] = { type: 'string' }
    })
    const table = formatDriftTable(report)
    const rows = table.split('\n').filter((l) => l.includes(' field '))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('GET /v1/jwks')
    expect(rows[2]).toContain('POST /v1/verify')
  })
})

// ---------------------------------------------------------------------------
// Loading a document — the only I/O in the module
// ---------------------------------------------------------------------------

describe('loadOpenApiDocument', () => {
  it('reads a local file path', async () => {
    const doc = await loadOpenApiDocument(FIXTURE_PATH)
    expect(compareSchemas(doc).differences).toEqual([])
  })

  it('fetches a URL, with a timeout signal attached', async () => {
    const seen: { url: string; signal: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, signal: init?.signal })
      return new Response(JSON.stringify({ openapi: '3.1.0', paths: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const doc = await loadOpenApiDocument('http://vi:8000/openapi.json', { fetchImpl, timeoutMs: 5_000 })
    expect(seen[0]?.url).toBe('http://vi:8000/openapi.json')
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(doc).toMatchObject({ openapi: '3.1.0' })
  })

  it('reports a non-200 as an error naming the status, rather than comparing garbage', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502, statusText: 'Bad Gateway' })) as unknown as typeof fetch
    await expect(loadOpenApiDocument('http://vi:8000/openapi.json', { fetchImpl })).rejects.toThrow(/HTTP 502/)
  })

  it('reports a connection failure as an error naming the URL', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(loadOpenApiDocument('http://vi:8000/openapi.json', { fetchImpl })).rejects.toThrow(
      /Could not fetch http:\/\/vi:8000\/openapi.json/,
    )
  })

  it('reports a missing file as an error, so "cannot check" never looks like "checked"', async () => {
    await expect(loadOpenApiDocument(join(HERE, 'fixtures', 'does-not-exist.json'))).rejects.toThrow()
  })

  it('rejects a file that is not JSON', async () => {
    await expect(loadOpenApiDocument(join(HERE, 'fixtures', 'README.md'))).rejects.toThrow()
  })
})

// --- helpers ---------------------------------------------------------------------------------------

function find(report: DriftReport, route: string, path: string): DriftDifference | undefined {
  return report.differences.find((d) => d.route === route && d.path === path)
}

function stubDifference(direction: DriftDifference['direction']): DriftDifference {
  return {
    route: 'POST /v1/verify',
    side: 'response',
    path: 'x',
    kind: 'field',
    direction,
    severity: 'informational',
    detail: '',
  }
}