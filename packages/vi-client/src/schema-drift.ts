/**
 * Schema drift — spec **§8.4 AT-M4.2**:
 *
 * > A schema drift test: vi exposes `/openapi.json`, and a script fails CI if the request/response
 * > fields differ from the zod schemas.
 *
 * ## What is compared, and what is deliberately not
 *
 * **Compared, per route and per side (request / response), recursively:**
 *
 * | Signal | Both directions? | Why it matters |
 * |---|---|---|
 * | field present / absent | **yes** | A field the service has and we do not: we silently drop data that may end up in a PayPal evidence packet. A field we require and the service does not: `zod` throws at runtime, on a 2xx that was otherwise fine. |
 * | required vs optional | **yes** | On a request, required-here-and-not-there means vi may reject an incomplete body. On a response, required-here-and-not-there means we demand a field that may be absent. |
 * | `type` (as an intersecting set) | yes | `amount_minor` silently becoming a string is a money bug waiting for a customer. |
 * | `enum` / `const` value sets | yes | A currency vi starts accepting, or a `kty` it stops accepting. |
 * | `additionalProperties` (open vs closed) | yes | Closed service + open client: vi 400s a body we allowed. Closed client + open service, on a *response*: we reject a value vi considers valid. |
 *
 * **Not compared: numeric bounds and string lengths.** pydantic and zod express the same bound with
 * different JSON Schema keywords (`ge`/`le` → `minimum`/`maximum`, `gt`/`lt` → `exclusiveMinimum` /
 * `exclusiveMaximum`) and pydantic renders them as floats (`365.0`). A bounds comparison would
 * therefore produce cosmetic CI failures with little marginal signal, while the drift that actually
 * breaks a caller — a field changing type, appearing, or disappearing — is all caught above. This is
 * a scoping decision and it is stated in the package README rather than hidden.
 *
 * ## Opaque positions are reported, not passed over
 *
 * vi declares several positions as bare `dict[str, Any]`: `public_jwk`, `L2PrepareResponse.header` /
 * `.payload`, each JWKS entry, and the items of `checkout_constraints` / `payment_constraints`. The
 * first four this client also types as opaque, so both sides agree that nothing is checkable. The
 * constraint arrays are different: **this client types them** (as the tagged union of the eight
 * registered types, spec §8.8), which is a deliberate improvement over the wire — it refuses a
 * constraint vi would reject with `VI_CONSTRAINT_VIOLATION` before spending the round trip. The
 * comparator reports that position as **unverifiable**, with the reason, rather than claiming a match
 * it cannot make. An unverifiable position is visible in the output and does **not** fail the check;
 * silently treating "cannot check" as "checked" is the failure mode worth avoiding here.
 *
 * ## Input is a document, not a URL
 *
 * {@link compareSchemas} takes the OpenAPI document as a value. {@link loadOpenApiDocument} accepts
 * either a URL or a local path and is the only function that touches the network or the filesystem.
 * That split is what lets AT-M4.2 be unit-tested today, against
 * `test/fixtures/openapi.vi-service.json`, with no vi-service running and no network access — and it
 * is what lets the CI job that *does* have a service run the identical comparison.
 */

import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import { ROUTE_CONTRACTS, routeKey } from './types'
import type { ContractSide, RouteContract } from './types'

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** Which side of the comparison a difference was found on. */
export type DriftDirection =
  /** The service has it; we do not. */
  | 'service-only'
  /** We have it; the service does not. */
  | 'client-only'

export type DriftKind =
  | 'field'
  | 'requiredness'
  | 'type'
  | 'enum'
  | 'const'
  | 'additional-properties'
  /** The client has a route the service does not declare. */
  | 'missing-route'
  /** The service declares a route the client does not have. */
  | 'unmodelled-route'

export interface DriftDifference {
  /** `"POST /v1/l2/prepare"`. */
  readonly route: string
  readonly side: ContractSide
  /** Dotted field path from the body root, or `$` for the body itself. */
  readonly path: string
  readonly kind: DriftKind
  readonly direction: DriftDirection
  /**
   * `breaking` — a caller is or would be handed something wrong, or would send something vi refuses.
   * `informational` — worth a human's attention, no runtime break.
   *
   * Every difference fails the CLI, because §8.4 says the script "fails CI if the request/response
   * fields differ". The severity is there so a reader knows which ones hurt at 3 a.m.
   */
  readonly severity: 'breaking' | 'informational'
  readonly detail: string
}

export interface UnverifiablePosition {
  readonly route: string
  readonly side: ContractSide
  readonly path: string
  readonly reason: string
}

export interface DriftReport {
  readonly differences: readonly DriftDifference[]
  readonly unverifiable: readonly UnverifiablePosition[]
  /** Route contracts compared, i.e. routes present in both the client and the document. */
  readonly routesCompared: number
  /** Routes the document declares, whether or not this client models them. */
  readonly routesInDocument: number
}

// ---------------------------------------------------------------------------
// Minimal OpenAPI / JSON Schema reading
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Json | undefined {
  return isRecord(value) ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Every branch of a node, flattened out of `anyOf` / `oneOf` / `allOf`.
 *
 * pydantic renders `int | None = None` as `anyOf: [{type: integer}, {type: null}]` and zod renders
 * `z.number().int().nullable()` as `anyOf: [{type: integer}, {type: null}]` too — but pydantic's
 * `Literal` and zod's `z.literal` differ, and FastAPI inlines some schemas while pydantic `$ref`s
 * others. Flattening means the comparison does not care which.
 */
function branchesOf(node: Json): Json[] {
  const out: Json[] = []
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const arr = node[key]
    if (Array.isArray(arr)) for (const b of arr) if (isRecord(b)) out.push(b)
  }
  return out
}

/** The set of JSON Schema `type` values a node can accept, ignoring "anything" branches. */
function typeSet(node: Json): Set<string> {
  const out = new Set<string>()
  const t = node['type']
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') out.add(v)
  for (const b of branchesOf(node)) for (const v of typeSet(b)) out.add(v)
  return out
}

/**
 * Does this node constrain anything at all?
 *
 * `{}` (and zod's `z.unknown()` → `{}`) means "any value". A field typed `z.union([number, bigint])`
 * has an `integer` branch and an unconstrained branch; intersecting with the unconstrained branch is
 * vacuously true, so unconstrained branches are dropped before comparing.
 */
function isUnconstrained(node: Json): boolean {
  if (Object.keys(node).length === 0) return true
  const structuralKeys = ['properties', 'items', 'enum', 'const', '$ref', 'required']
  if (structuralKeys.some((k) => k in node)) return false
  if (branchesOf(node).length > 0) return false
  const t = typeSet(node)
  return t.size === 0
}

/** The single structural branch of a nullable wrapper, if there is exactly one. */
function structuralBranch(node: Json): Json | undefined {
  const branches = branchesOf(node)
  if (branches.length === 0) return undefined
  const structural = branches.filter(
    (b) => !isUnconstrained(b) && !(typeSet(b).size === 1 && typeSet(b).has('null')),
  )
  return structural.length === 1 ? structural[0] : undefined
}

function allowsNull(node: Json): boolean {
  if (typeSet(node).has('null')) return true
  const d = node['default']
  return d === null
}

/** `additionalProperties`: `false` is closed, `true`/`{}`/absent-with-no-properties is open. */
function isClosed(node: Json): boolean {
  if (!('properties' in node) && !('additionalProperties' in node)) return false
  return node['additionalProperties'] === false
}

/**
 * Is this node an object (as opposed to a string, an integer, an array)?
 *
 * Needed because a leaf such as `{"type": "string", "minLength": 1}` has no `properties` either, and
 * treating every property-less node as an opaque `dict[str, Any]` would bury the real findings under one
 * `unverifiable` line per field of every response.
 */
function isObjectLike(node: Json): boolean {
  const t = typeSet(node)
  if (t.size > 0) return t.has('object')
  // No declared type at all: a bare `{"additionalProperties": …}` or a `{"properties": …}` is an object.
  return 'properties' in node || 'additionalProperties' in node
}

function propsOf(node: Json): Record<string, Json> {
  const p = node['properties']
  if (!isRecord(p)) return {}
  const out: Record<string, Json> = {}
  for (const [k, v] of Object.entries(p)) if (isRecord(v)) out[k] = v
  return out
}

function requiredOf(node: Json): Set<string> {
  return new Set(asStringArray(node['required']))
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

/** Resolve `#/components/schemas/Name`. Anything else is treated as unresolvable. */
function makeResolver(doc: Json): (node: Json) => Json | undefined {
  const components = asRecord(asRecord(doc['components'])?.['schemas'])
  return (node) => {
    const ref = node['$ref']
    if (typeof ref !== 'string') return node
    const prefix = '#/components/schemas/'
    if (!ref.startsWith(prefix)) return undefined
    const target = components?.[ref.slice(prefix.length)]
    return asRecord(target)
  }
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

interface Ctx {
  readonly resolve: (node: Json) => Json | undefined
  readonly differences: DriftDifference[]
  readonly unverifiable: UnverifiablePosition[]
  readonly route: string
  readonly side: ContractSide
}

function add(
  ctx: Ctx,
  path: string,
  kind: DriftKind,
  direction: DriftDirection,
  severity: 'breaking' | 'informational',
  detail: string,
): void {
  ctx.differences.push({
    route: ctx.route,
    side: ctx.side,
    path,
    kind,
    direction,
    severity,
    detail,
  })
}

function note(ctx: Ctx, path: string, reason: string): void {
  ctx.unverifiable.push({ route: ctx.route, side: ctx.side, path, reason })
}

/** Join a field path. `$` is the body root. */
function child(path: string, key: string): string {
  return path === '$' ? key : `${path}.${key}`
}

/**
 * Compare one node pair.
 *
 * Returns after reporting; it never throws, because a malformed document must produce a report a human
 * can read rather than a stack trace.
 */
function compareNode(ctx: Ctx, serviceRaw: Json, clientRaw: Json, path: string): void {
  const service = ctx.resolve(serviceRaw)
  if (service === undefined) {
    note(
      ctx,
      path,
      'the document uses a $ref this comparator cannot resolve (expected #/components/schemas/…)',
    )
    return
  }
  const client = ctx.resolve(clientRaw)
  if (client === undefined) {
    add(
      ctx,
      path,
      'field',
      'client-only',
      'breaking',
      'the client schema is an unresolvable $ref, which cannot happen',
    )
    return
  }

  // --- type ---------------------------------------------------------------------------------------
  const serviceTypes = typeSet(service)
  const clientTypes = typeSet(client)
  const concrete = (s: Set<string>) => new Set([...s].filter((t) => t !== 'null'))
  const sT = concrete(serviceTypes)
  const cT = concrete(clientTypes)
  if (sT.size > 0 && cT.size > 0) {
    const overlap = [...sT].some((t) => cT.has(t))
    if (!overlap) {
      add(
        ctx,
        path,
        'type',
        'service-only',
        'breaking',
        `the service declares type {${[...sT].sort().join(', ')}} but the client accepts {${[...cT].sort().join(', ')}}`,
      )
      return
    }
  }

  // A client that refuses null where the service may send it is a runtime parse failure waiting to
  // happen on an optional field.
  if (allowsNull(service) && !allowsNull(client) && ctx.side === 'response') {
    add(
      ctx,
      path,
      'type',
      'service-only',
      'breaking',
      'the service may send null here but the client schema is not nullable',
    )
  }

  // --- enum / const -------------------------------------------------------------------------------
  const serviceEnum = service['enum']
  const clientEnum = client['enum']
  if (Array.isArray(serviceEnum) && Array.isArray(clientEnum)) {
    const s = new Set(serviceEnum.map((v) => JSON.stringify(v)))
    const c = new Set(clientEnum.map((v) => JSON.stringify(v)))
    const onlyService = [...s].filter((v) => !c.has(v))
    const onlyClient = [...c].filter((v) => !s.has(v))
    for (const v of onlyService) {
      add(
        ctx,
        path,
        'enum',
        'service-only',
        'informational',
        `the service allows ${v} and the client does not`,
      )
    }
    for (const v of onlyClient) {
      add(
        ctx,
        path,
        'enum',
        'client-only',
        'breaking',
        `the client allows ${v} and the service does not`,
      )
    }
  }
  if ('const' in service || 'const' in client) {
    const sv = JSON.stringify(service['const'])
    const cv = JSON.stringify(client['const'])
    if (sv !== cv) {
      add(
        ctx,
        path,
        'const',
        sv === undefined ? 'client-only' : 'service-only',
        'breaking',
        `the service pins ${sv} and the client pins ${cv}`,
      )
    }
  }

  // --- arrays -------------------------------------------------------------------------------------
  const serviceItems = asRecord(service['items'])
  const clientItems = asRecord(client['items'])
  if (serviceItems && clientItems) {
    compareNode(ctx, serviceItems, clientItems, `${path}[]`)
    return
  }

  // --- objects ------------------------------------------------------------------------------------
  // Unwrap a nullable wrapper (`anyOf: [{$ref: AtTimeCheck}, {type: null}]`) and then resolve the `$ref`,
  // in that order: an unresolved `{$ref: …}` wrapper has no `type` and no `properties`, so it would look
  // like an opaque dict and every field inside it would go unreported.
  const serviceStructural =
    ctx.resolve(structuralBranch(service) ?? service) ?? structuralBranch(service) ?? service
  const clientStructural = structuralBranch(client) ?? client
  // Both sides are leaves (a string, an integer, …). The type comparison above has already had its say.
  if (!isObjectLike(serviceStructural) && !isObjectLike(clientStructural)) return
  const serviceProps = propsOf(serviceStructural)
  const clientProps = propsOf(clientStructural)

  // The service declares an object with no declared properties: `dict[str, Any]` or
  // `{"type": "object"}`. Nothing about its fields can be compared, whichever side is typed.
  if (Object.keys(serviceProps).length === 0 && !isClosed(serviceStructural)) {
    if (Object.keys(clientProps).length === 0) {
      note(
        ctx,
        path,
        'the service declares an opaque object (dict[str, Any]); both sides are untyped here',
      )
    } else {
      note(
        ctx,
        path,
        'the service declares an opaque object (dict[str, Any]) while the client types its fields, so the two cannot be compared',
      )
    }
    return
  }
  if (Object.keys(clientProps).length === 0) {
    note(
      ctx,
      path,
      'the client types this position as opaque while the service declares named fields',
    )
    return
  }

  // `additionalProperties`
  const serviceClosed = isClosed(serviceStructural)
  const clientClosed = isClosed(clientStructural)
  if (serviceClosed && !clientClosed) {
    add(
      ctx,
      path,
      'additional-properties',
      'client-only',
      'breaking',
      'the service forbids extra fields and the client allows them, so the client can build a body vi will reject',
    )
  } else if (!serviceClosed && clientClosed && ctx.side === 'response') {
    add(
      ctx,
      path,
      'additional-properties',
      'service-only',
      'breaking',
      'the service may send extra fields and the client forbids them, so a legitimate response would be rejected',
    )
  } else if (!serviceClosed && clientClosed) {
    add(
      ctx,
      path,
      'additional-properties',
      'service-only',
      'informational',
      'the client forbids extra fields where the service allows them (requests only; harmless because the client builds the body)',
    )
  }

  // --- fields, both directions ---------------------------------------------------------------------
  for (const [name, node] of Object.entries(serviceProps)) {
    if (!(name in clientProps)) {
      add(
        ctx,
        child(path, name),
        'field',
        'service-only',
        'informational',
        'the service sends this field and the client does not model it',
      )
      continue
    }
    compareNode(ctx, node, clientProps[name] as Json, child(path, name))
  }
  for (const name of Object.keys(clientProps)) {
    if (!(name in serviceProps)) {
      add(
        ctx,
        child(path, name),
        'field',
        'client-only',
        'breaking',
        'the client requires this field and the service does not declare it',
      )
    }
  }

  // --- requiredness, both directions ----------------------------------------------------------------
  const serviceRequired = requiredOf(serviceStructural)
  const clientRequired = requiredOf(clientStructural)
  for (const name of Object.keys(clientProps)) {
    if (clientRequired.has(name) && !serviceRequired.has(name)) {
      // On a request this is harmless at runtime — we always send what we require — but it is still
      // drift, and §8.4 says the fields must not differ. On a **response** it breaks at runtime: we
      // demand a field the service no longer guarantees.
      add(
        ctx,
        child(path, name),
        'requiredness',
        'client-only',
        ctx.side === 'response' ? 'breaking' : 'informational',
        ctx.side === 'request'
          ? 'the client requires this field but the service declares it optional'
          : 'the client requires this field but the service does not guarantee it',
      )
    }
  }
  for (const name of Object.keys(serviceProps)) {
    if (serviceRequired.has(name) && !clientRequired.has(name)) {
      // The mirror image: on a request, a field the service demands and we treat as optional is how a
      // caller omits something and vi answers 400. On a response it is safe — we made an optional field
      // of a promised field, so we would only ignore it.
      add(
        ctx,
        child(path, name),
        'requiredness',
        'service-only',
        ctx.side === 'request' ? 'breaking' : 'informational',
        ctx.side === 'request'
          ? 'the service requires this field and the client treats it as optional, so a caller may omit it and vi will reject the body'
          : 'the service always sends this field and the client treats it as optional',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Per-route extraction
// ---------------------------------------------------------------------------

/** The `application/json` schema of a request body, if the operation declares one. */
function requestSchemaOf(op: Json): Json | undefined {
  const body = asRecord(op['requestBody'])
  const content = asRecord(body?.['content'])
  const media = asRecord(content?.['application/json'])
  return asRecord(media?.['schema'])
}

/** The `200` `application/json` schema of an operation, if it declares one. */
function responseSchemaOf(op: Json): Json | undefined {
  const responses = asRecord(op['responses'])
  const ok = asRecord(responses?.['200'])
  const content = asRecord(ok?.['content'])
  const media = asRecord(content?.['application/json'])
  return asRecord(media?.['schema'])
}

function compareSide(
  resolve: (node: Json) => Json | undefined,
  contract: RouteContract,
  serviceNode: Json | undefined,
  clientSchema: z.ZodType | undefined,
  side: ContractSide,
  differences: DriftDifference[],
  unverifiable: UnverifiablePosition[],
): void {
  const key = routeKey(contract.method, contract.path)
  const ctx: Ctx = { resolve, differences, unverifiable, route: key, side }

  if (serviceNode === undefined) {
    if (clientSchema === undefined) return
    if (side === 'request') {
      add(
        ctx,
        '$',
        'field',
        'client-only',
        'breaking',
        'the client sends a request body but the service declares none for this route',
      )
    } else {
      // A missing *response schema* is an unverifiable position, not a client-side defect: vi declaring no
      // schema means the service itself has nothing to compare against, so claiming a drift would be the
      // comparator faulting itself for the service's choice. `GET /v1/checkout-jwt/verify` is the case.
      note(
        ctx,
        '$',
        'the service declares no response schema for this route (vi returns a bare dict), so the response fields cannot be checked',
      )
    }
    return
  }
  if (clientSchema === undefined) {
    note(ctx, '$', 'the client models no schema for this side of the route')
    return
  }

  let clientNode: Json
  try {
    // `io: 'input'` is the accepted wire shape, which is what the OpenAPI document describes. Using the
    // *output* side would compare our transforms (money as bigint) against a JSON integer and report
    // drift on every money field.
    clientNode = z.toJSONSchema(clientSchema, { io: 'input', unrepresentable: 'any' }) as Json
  } catch (e) {
    note(
      ctx,
      '$',
      `the client schema could not be converted to JSON Schema: ${e instanceof Error ? e.message : String(e)}`,
    )
    return
  }
  compareNode(ctx, serviceNode, clientNode, '$')
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compare an OpenAPI document against this client's zod schemas.
 *
 * Never throws on a malformed document: an unreadable `paths` block becomes one `unmodelled-route`
 * difference per route rather than an exception, so the CLI can always print a table.
 *
 * **Routes the service declares that this client does not model are reported as `unmodelled-route`.**
 * That direction matters as much as the other one: a route added to `apps/vi` and not to this client
 * is a silently absent capability, and the drift check is the only place that would notice.
 *
 * @param contracts the route manifest to check. Defaults to {@link ROUTE_CONTRACTS}. It is a parameter
 *   rather than a hard-coded constant so the comparator's own rules can be exercised against a synthetic
 *   route: `test/schema-drift.test.ts` needs an `additionalProperties` combination the real manifest never
 *   produces, and reaching for one by editing `types.ts` would make a test depend on production shape.
 */
export function compareSchemas(
  openapi: unknown,
  contracts: readonly RouteContract[] = ROUTE_CONTRACTS,
): DriftReport {
  const differences: DriftDifference[] = []
  const unverifiable: UnverifiablePosition[] = []
  const doc = asRecord(openapi) ?? {}
  const resolve = makeResolver(doc)
  const paths = asRecord(doc['paths']) ?? {}

  let routesInDocument = 0
  for (const p of Object.keys(paths)) {
    const item = asRecord(paths[p])
    if (!item) continue
    for (const m of Object.keys(item)) {
      if (m === 'get' || m === 'post' || m === 'put' || m === 'patch' || m === 'delete')
        routesInDocument += 1
    }
  }

  let routesCompared = 0
  const seen = new Set<string>()
  for (const contract of contracts) {
    const key = routeKey(contract.method, contract.path)
    const op = asRecord(asRecord(paths[contract.path])?.[contract.method.toLowerCase()])
    if (!op) {
      differences.push({
        route: key,
        side: 'response',
        path: '$',
        kind: 'missing-route',
        direction: 'client-only',
        severity: 'breaking',
        detail: 'the client models this route but the document does not declare it',
      })
      continue
    }
    seen.add(`${contract.method} ${contract.path}`)
    routesCompared += 1
    if (contract.request !== undefined) {
      compareSide(
        resolve,
        contract,
        requestSchemaOf(op),
        contract.request,
        'request',
        differences,
        unverifiable,
      )
    }
    compareSide(
      resolve,
      contract,
      responseSchemaOf(op),
      contract.response,
      'response',
      differences,
      unverifiable,
    )
  }

  for (const [path, item] of Object.entries(paths)) {
    const rec = asRecord(item)
    if (!rec) continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      if (!rec[method]) continue
      const key = routeKey(method.toUpperCase(), path)
      if (seen.has(key)) continue
      differences.push({
        route: key,
        side: 'response',
        path: '$',
        kind: 'unmodelled-route',
        direction: 'service-only',
        severity: 'informational',
        detail: 'the service declares this route but the client has no method for it',
      })
    }
  }

  return { differences, unverifiable, routesCompared, routesInDocument }
}

/** True when the comparison found anything at all. §8.4 says the script fails CI on any difference. */
export function hasDrift(report: DriftReport): boolean {
  return report.differences.length > 0
}

// ---------------------------------------------------------------------------
// Loading a document
// ---------------------------------------------------------------------------

export interface LoadOpenApiOptions {
  readonly fetchImpl?: typeof fetch
  /** Reported in the thrown error when a fetch fails. Never logged on its own. */
  readonly timeoutMs?: number
}

/**
 * Load an OpenAPI document from a URL or a local file path.
 *
 * The only I/O in this module, so the comparison itself stays a pure function of a value.
 *
 * - `http://…` / `https://…` → `GET <url>`, expecting JSON.
 * - anything else → treated as a filesystem path.
 */
export async function loadOpenApiDocument(
  source: string,
  options: LoadOpenApiOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (/^https?:\/\//i.test(source)) {
    const doFetch = options.fetchImpl ?? fetch
    let response: Response
    try {
      response = await doFetch(source, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new Error(`Could not fetch ${source}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
    if (!response.ok) {
      throw new Error(`Could not fetch ${source}: HTTP ${response.status} ${response.statusText}`)
    }
    return (await response.json()) as unknown
  }
  const text = await readFile(source, 'utf8')
  return JSON.parse(text) as unknown
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width
    ? `${s.slice(0, Math.max(0, width - 1))}…`
    : s + ' '.repeat(width - s.length)
}

/**
 * Render a report as a fixed-width table, so a diff reads the same in CI logs as it does on a terminal.
 *
 * The order of the rows is deterministic (route, side, path, kind), which matters for a CI job that
 * diffs two runs of the script.
 */
export function formatDriftTable(report: DriftReport): string {
  const lines: string[] = []
  lines.push(
    `schema drift: ${report.routesCompared}/${report.routesInDocument} routes in the document are modelled by this client`,
  )
  lines.push('')
  if (report.differences.length === 0) {
    lines.push('  no differences')
  } else {
    lines.push(
      `${pad('ROUTE', 26)} ${pad('SIDE', 9)} ${pad('PATH', 30)} ${pad('KIND', 12)} ${pad('DIR', 13)} ${pad('SEVERITY', 13)} DETAIL`,
    )
    const rows = [...report.differences].sort((a, b) =>
      `${a.route}|${a.side}|${a.path}|${a.kind}`.localeCompare(
        `${b.route}|${b.side}|${b.path}|${b.kind}`,
      ),
    )
    for (const d of rows) {
      lines.push(
        `${pad(d.route, 26)} ${pad(d.side, 9)} ${pad(d.path, 30)} ${pad(d.kind, 12)} ${pad(d.direction, 13)} ${pad(d.severity, 13)} ${d.detail}`,
      )
    }
  }
  if (report.unverifiable.length > 0) {
    lines.push('')
    lines.push('unverifiable positions (reported, not compared, and not a failure):')
    for (const u of report.unverifiable) {
      lines.push(`  ${pad(`${u.route} ${u.side} ${u.path}`, 60)} ${u.reason}`)
    }
  }
  return lines.join('\n')
}
